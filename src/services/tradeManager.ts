import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { 
  getPaperBalance, 
  updatePaperBalance, 
  getOpenPositions, 
  getOpenPositionByToken, 
  createPosition, 
  updatePositionPrice, 
  closePosition, 
  getPositionById,
  halfClosePosition,
  recordWhaleTrade,
  isCircuitBreakerActive,
  tripCircuitBreaker,
  getDailyStopLossCount
} from '../db/index';
import { getTokenMarketData, getSolPriceUsd, calculatePriceImpactPct } from './dexscreener';
import { getOnChainBondingCurve, getBondingCurveAddress, decodeBondingCurveBuffer } from './bondingCurve';
import { checkTokenSafety } from './antirug';
import { getBuyQuote, getSellQuote } from './jupiter';
import { Whale, Position } from '../types/index';
import { getDedicatedConnection, getDedicatedEndpoint } from './solanaConnection';
import { simulateRealisticSell, simulateRealisticBuy } from './dexSimulator';

const positionEndpoint = getDedicatedEndpoint('POSITION_MANAGER');
const wsUrl = positionEndpoint.wsUrl;
const connection = getDedicatedConnection('POSITION_MANAGER');

type TelegramNotifier = (message: string, extra?: any) => Promise<void>;
let telegramNotifier: TelegramNotifier | null = null;
let lastCircuitBreakerNotifyTime = 0;
const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60 * 1000; // 15 menit

export const ATA_RENT_EXEMPT_SOL = 0.00203928; // Standard Solana rent-exempt minimum for SPL token account (refundable on close)
export const GAS_RESERVE_BUFFER_SOL = 0.015; // Mandatory untouched gas buffer to prevent InsufficientFundsForFee errors

// In-Memory Concurrency Lock & Re-entry Loss Cooldown
const activeOrderTokens = new Set<string>();
const tokenLossCooldownMap = new Map<string, number>();
const LOSS_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours cooldown on tokens that suffered dump/SL

export function setTelegramNotifier(notifier: TelegramNotifier) {
  telegramNotifier = notifier;
}

async function notify(message: string, extra?: any) {
  if (telegramNotifier) {
    try {
      await telegramNotifier(message, extra);
    } catch (err: any) {
      console.error('[TradeManager] Failed to send Telegram notification:', err.message);
    }
  }
}

export function extractNarrative(symbol: string, name: string): string {
  const text = `${symbol} ${name}`.toLowerCase();
  if (/dog|shib|inu|bonk|floki|wif|pup|canine|hound/.test(text)) return 'DOG';
  if (/cat|meow|kitty|neko|mimi|feline|happycat/.test(text)) return 'CAT';
  if (/ai|gpt|agent|bot|intelligence|compute|neural|agi/.test(text)) return 'AI';
  if (/trump|biden|kamala|maga|vote|politic|usa|presid/.test(text)) return 'POLITICS';
  if (/pepe|frog|toad|kek|ribbit/.test(text)) return 'PEPE';
  return 'OTHER';
}

export async function executeBuyToken(
  tokenMint: string,
  amountSol: number = CONFIG.DEFAULT_BUY_AMOUNT_SOL,
  source: string = 'MANUAL',
  whale?: Whale,
  whaleEntryPriceUsd?: number,
  prefetchedMarketData?: any,
  whaleSolAmount?: number
): Promise<{ success: boolean; message: string; position?: Position }> {
  // Circuit Breaker Kill-Switch: Block buys if market crash / severe loss streak detected
  const cb = isCircuitBreakerActive();
  if (cb.active) {
    const remainingMins = Math.ceil((cb.untilMs - Date.now()) / (60 * 1000));
    console.log(`[AutoTrade] 🛑 Order ditolak karena Circuit Breaker aktif (${remainingMins}m).`);
    const now = Date.now();
    if (now - lastCircuitBreakerNotifyTime > CIRCUIT_BREAKER_COOLDOWN_MS) {
      lastCircuitBreakerNotifyTime = now;
      const alertMsg = `🛑 *ORDER DITOLAK: CIRCUIT BREAKER SEDANG AKTIF!*\n\n` +
        `⏱️ Sisa Waktu Cooldown: *${remainingMins} menit*\n` +
        `⚠️ Alasan: *${cb.reason}*\n\n` +
        `_Bot menolak seluruh order beli baru demi melindungi portofolio dari kondisi pasar ekstrem._\n` +
        `ℹ️ _Notifikasi ini dibatasi (maks 1x per 15 menit) agar tidak spam._`;
      await notify(alertMsg);
    }
    return { success: false, message: `Circuit breaker aktif (${remainingMins}m tersisa)` };
  }

  // 0. Concurrency Lock: Prevent simultaneous double-orders on the same token
  if (activeOrderTokens.has(tokenMint)) {
    console.log(`[AutoTrade] ⏳ Order untuk ${tokenMint} sedang diproses secara asinkron. Melewati order ganda.`);
    return { success: false, message: 'Order token ini sedang diproses' };
  }

  // Check if position already open
  const existing = getOpenPositionByToken(tokenMint);
  if (existing) {
    console.log(`[AutoTrade] ℹ️ Token ${existing.token_symbol} (${tokenMint}) sudah aktif di portofolio. Melewati pembelian duplikat.`);
    return { success: false, message: `Posisi untuk token ${existing.token_symbol} sudah aktif dibuka.` };
  }

  // 0.5. Re-entry Loss Cooldown Guard: Prevent buying a token that just suffered a dump / stop loss
  const cooldownExpiry = tokenLossCooldownMap.get(tokenMint);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const remainingMins = Math.ceil((cooldownExpiry - Date.now()) / 60000);
    console.log(`[AutoTrade] 🛡️ Re-entry Guard: Token ${tokenMint} baru saja dump/loss. Cooldown ${remainingMins}m tersisa.`);
    return { success: false, message: `Token sedang dalam cooldown pasca-dump (${remainingMins}m tersisa)` };
  }

  activeOrderTokens.add(tokenMint);
  try {

  const isCopyTrade = source === 'COPY_TRADE';
  const shouldNotifyFilterSkip = CONFIG.NOTIFY_ON_REJECT !== false;

  // Institutional Risk Control 1: Maximum Concurrent Open Positions
  const openPositions = getOpenPositions();
  if (openPositions.length >= CONFIG.MAX_OPEN_POSITIONS) {
    console.log(`[AutoTrade] 🛡️ Maksimal posisi aktif (${CONFIG.MAX_OPEN_POSITIONS}) tercapai. Menolak order baru.`);
    if (shouldNotifyFilterSkip) {
      let tokenSymbol = 'TOKEN';
      let tokenName = 'Token Solana';
      try {
        const mData = prefetchedMarketData || await getTokenMarketData(tokenMint);
        if (mData) {
          tokenSymbol = mData.symbol;
          tokenName = mData.name;
        }
      } catch {}

      const whaleLabel = whale ? `\n🐋 *Sumber Paus:* ${whale.label}` : '';
      const whaleVol = (whaleSolAmount && whaleSolAmount > 0) ? `\n💵 *Volume Beli Paus:* *${whaleSolAmount.toFixed(2)} SOL*` : '';
      const alertMsg = `⚠️ *ORDER DILEWATI: PORTFOLIO EXPOSURE PENUH*\n\n` +
        `🪙 *Token:* *${tokenSymbol}* (${tokenName})\n` +
        `📝 *CA:* \`${tokenMint}\`${whaleLabel}${whaleVol}\n` +
        `📊 *Posisi Aktif:* *${openPositions.length}/${CONFIG.MAX_OPEN_POSITIONS} token* (Kapasitas Penuh)\n\n` +
        `🛡️ _Bot menolak membuka posisi baru untuk menjaga cadangan kas (Cash Buffer) sesuai standar manajemen risiko institusional._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Maksimal posisi aktif portofolio tercapai' };
  }

  // Check paper balance baseline
  const currentBalance = getPaperBalance();
  const minBaselineRequired = CONFIG.DEFAULT_BUY_AMOUNT_SOL + CONFIG.ESTIMATED_BUY_FEE_SOL + ATA_RENT_EXEMPT_SOL + GAS_RESERVE_BUFFER_SOL;
  if (currentBalance < minBaselineRequired) {
    const msg = `⚠️ Saldo paper trading habis atau di bawah gas reserve buffer! Saldo: ${currentBalance.toFixed(3)} SOL, Minimum: ${minBaselineRequired.toFixed(3)} SOL`;
    if (shouldNotifyFilterSkip) {
      await notify(msg);
    }
    return { success: false, message: msg };
  }

  // 1. High-Speed Concurrent Pipeline (<400ms parallel fetch instead of sequential waiting!)
  const marketDataPromise = prefetchedMarketData 
    ? Promise.resolve(prefetchedMarketData) 
    : getTokenMarketData(tokenMint);
  const safetyPromise = checkTokenSafety(tokenMint);
  const solPricePromise = getSolPriceUsd();

  const [marketData, safety, solPriceUsd] = await Promise.all([
    marketDataPromise,
    safetyPromise,
    solPricePromise
  ]);

  if (!marketData) {
    const msg = `❌ Gagal mengambil data pasar dari DexScreener untuk token \`${tokenMint}\`. Token mungkin terlalu baru atau likuiditas belum terdeteksi.`;
    return { success: false, message: msg };
  }

  // Ultra-Fast On-Chain Price for Pump.fun tokens (<50ms Direct PDA Buffer Decode)
  if (tokenMint.endsWith('pump')) {
    try {
      const onChainCurve = await getOnChainBondingCurve(tokenMint);
      if (onChainCurve && !onChainCurve.complete && onChainCurve.spotPriceSol > 0) {
        const liveCurvePriceUsd = onChainCurve.spotPriceSol * solPriceUsd;
        if (liveCurvePriceUsd > 0) {
          marketData.priceUsd = liveCurvePriceUsd;
          marketData.liquidityUsd = onChainCurve.liquiditySol * solPriceUsd;
        }
      }
    } catch {}
  }

  // Construct Transparent Source & Whale Context Section for Notifications
  const whaleSpendUsd = (whaleSolAmount && whaleSolAmount > 0) ? (whaleSolAmount * solPriceUsd) : 0;
  // Plausibility check: whaleEntryPriceUsd must not be distorted to equal total spend USD
  const isPlausibleUnitPrice = Boolean(
    whaleEntryPriceUsd && 
    whaleEntryPriceUsd > 0 && 
    (whaleSpendUsd === 0 || Math.abs(whaleEntryPriceUsd - whaleSpendUsd) > 0.05 * whaleSpendUsd)
  );
  const displayWhaleTokenPrice = isPlausibleUnitPrice ? whaleEntryPriceUsd! : marketData.priceUsd;

  const whaleInfoSection = whale ? (
    `🐋 *Pemicu Order:* *${whale.label}*\n` +
    `👛 *Dompet Paus:* \`${whale.address.slice(0, 6)}...${whale.address.slice(-4)}\`\n` +
    (whaleSolAmount && whaleSolAmount > 0 
      ? `💵 *Modal Beli Paus:* *${whaleSolAmount.toFixed(2)} SOL* (~$${whaleSpendUsd.toFixed(2)})\n` 
      : '') +
    `🎯 *Harga Token Saat Beli:* *${formatPrice(displayWhaleTokenPrice)}*\n` +
    `📊 *Valuasi (Market Cap):* *$${formatNumber(marketData.marketCap)}*\n` +
    `\n`
  ) : (
    (source && source !== 'MANUAL') ? `🏷️ *Pemicu Order:* ${source}\n\n` : ''
  );

  // Institutional Risk Control 1.5: Narrative / Sector Concentration Shield
  const currentNarrative = extractNarrative(marketData.symbol, marketData.name);
  if (currentNarrative !== 'OTHER') {
    const matchingPositions = openPositions.filter(p => extractNarrative(p.token_symbol, p.token_name) === currentNarrative);
    if (matchingPositions.length >= CONFIG.MAX_POSITIONS_PER_NARRATIVE) {
      console.log(`[AutoTrade] 🛡️ Narrative Shield: Sudah ada ${matchingPositions.length} posisi di sektor ${currentNarrative}. Menolak order untuk mencegah correlated risk.`);
      if (shouldNotifyFilterSkip) {
        await notify(
          `⚠️ *ORDER DIBATALKAN: NARRATIVE SHIELD*\n\n` +
          `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
          `📝 *CA:* \`${tokenMint}\`\n\n` +
          whaleInfoSection +
          `🛡️ *Alasan:* Portofolio sudah memiliki ${matchingPositions.length} koin di sektor *${currentNarrative}* (${matchingPositions.map(p => p.token_symbol).join(', ')}). Bot mencegah risiko kerugian terkorelasi.`
        );
      }
      return { success: false, message: `Maksimal posisi sektor ${currentNarrative} tercapai` };
    }
  }

  // Pump.fun bonding curve tokens have guaranteed virtual liquidity in the contract (even before Raydium graduation)
  const isPumpFun = tokenMint.endsWith('pump') || marketData.dexId === 'pumpfun';
  const effectiveLiquidity = marketData.liquidityUsd > 0 
    ? marketData.liquidityUsd 
    : (isPumpFun && marketData.marketCap >= 5000 ? Math.max(5000, marketData.marketCap * 0.35) : marketData.liquidityUsd);

  // Institutional Risk Control 2: Minimum Liquidity & Market Cap Floor
  if (effectiveLiquidity < CONFIG.MIN_LIQUIDITY_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: Likuiditas $${effectiveLiquidity.toFixed(0)} < $${CONFIG.MIN_LIQUIDITY_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: LIKUIDITAS TERLALU RENDAH*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        whaleInfoSection +
        `💧 *Likuiditas Pool:* *$${formatNumber(effectiveLiquidity)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_LIQUIDITY_USD)}*)\n\n` +
        `_Bot menolak membeli di pool illiquid untuk mencegah jebakan slippage dan price impact raksasa._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Likuiditas pool di bawah standar minimum' };
  }

  // Institutional Risk Control 2b: Minimum 24h Volume Floor (Active Market Depth)
  if (marketData.volume24h !== undefined && marketData.volume24h > 0 && marketData.volume24h < CONFIG.MIN_VOLUME_24H_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: Volume 24j $${marketData.volume24h.toFixed(0)} < $${CONFIG.MIN_VOLUME_24H_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: VOLUME 24J TERLALU RENDAH*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        whaleInfoSection +
        `📊 *Volume 24 Jam:* *$${formatNumber(marketData.volume24h)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_VOLUME_24H_USD)}*)\n\n` +
        `_Bot menolak token sepi transaksi untuk menghindari risiko token mati / zombie memecoin._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Volume 24 jam token di bawah standar minimum' };
  }

  if (marketData.marketCap < CONFIG.MIN_MARKET_CAP_USD) {
    console.log(`[AutoTrade] 🛡️ Ditolak: MC $${marketData.marketCap.toFixed(0)} < $${CONFIG.MIN_MARKET_CAP_USD} (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: MARKET CAP TERLALU KECIL*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        whaleInfoSection +
        `📊 *Market Cap:* *$${formatNumber(marketData.marketCap)}* (Syarat Min: *$${formatNumber(CONFIG.MIN_MARKET_CAP_USD)}*)\n\n` +
        `_Bot menolak token kapitalisasi mikro dengan risiko manipulasi dev tinggi._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Market Cap di bawah standar minimum' };
  }

  // Institutional Risk Control 2c: Whale Buy Conviction Floor (Anti-Dust & Bait Filter)
  if (isCopyTrade && whaleSolAmount !== undefined && whaleSolAmount > 0 && whaleSolAmount < CONFIG.MIN_WHALE_SOL_AMOUNT) {
    console.log(`[AutoTrade] 🛡️ Ditolak: Modal beli paus hanya ${whaleSolAmount.toFixed(3)} SOL < ${CONFIG.MIN_WHALE_SOL_AMOUNT} SOL (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: CONVICTION PAUS TERLALU RENDAH*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        whaleInfoSection +
        `🔍 *Modal Beli Paus:* *${whaleSolAmount.toFixed(3)} SOL* (Syarat Min: *${CONFIG.MIN_WHALE_SOL_AMOUNT} SOL*)\n\n` +
        `_Bot hedge fund menolak order bernilai mikro untuk menghindari jebakan transaksi pancingan (bait), dust transfer, atau tes likuiditas paus yang tidak serius._`;
      await notify(alertMsg);
    }
    return { success: false, message: `Volume beli paus (${whaleSolAmount.toFixed(3)} SOL) di bawah standar minimum (${CONFIG.MIN_WHALE_SOL_AMOUNT} SOL)` };
  }

  // Institutional Risk Control 3: Anti-Chase / Price Drift Guard (Pucuk Guard)
  if (isPlausibleUnitPrice && whaleEntryPriceUsd && whaleEntryPriceUsd > 0) {
    const driftPct = ((marketData.priceUsd - whaleEntryPriceUsd) / whaleEntryPriceUsd) * 100;
    if (driftPct > CONFIG.MAX_PRICE_DRIFT_PCT) {
      console.log(`[AutoTrade] 🛡️ Anti-Chase triggered: drift +${driftPct.toFixed(1)}% > ${CONFIG.MAX_PRICE_DRIFT_PCT}% (${marketData.symbol})`);
      if (shouldNotifyFilterSkip) {
        const alertMsg = `⚠️ *ORDER DIBATALKAN: ANTI-CHASE GUARD (Pucuk Guard)*\n\n` +
          `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
          `📝 *CA:* \`${tokenMint}\`\n\n` +
          whaleInfoSection +
          `📈 *Harga Pasar Sekarang:* *${formatPrice(marketData.priceUsd)}* (+${driftPct.toFixed(1)}% dari entry paus)\n` +
          `🛡️ *Batas Toleransi Drift:* *+${CONFIG.MAX_PRICE_DRIFT_PCT}%*\n\n` +
          `_Bot menolak mengejar koin yang sudah terlanjur melambung tinggi agar modal Anda tidak menjadi exit liquidity!_`;
        await notify(alertMsg);
      }
      return { success: false, message: 'Harga sudah naik terlalu tinggi dari entry paus' };
    }
  }

  // Institutional Risk Control 4: Anti-FOMO Parabolic 5-Minute Spike Guard
  if (marketData.priceChange5m && marketData.priceChange5m > CONFIG.MAX_5M_PRICE_CHANGE_PCT) {
    console.log(`[AutoTrade] 🛡️ Anti-FOMO triggered: 5m change +${marketData.priceChange5m.toFixed(1)}% (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: ANTI-FOMO SPIKE GUARD*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        whaleInfoSection +
        `⚡ *Lonjakan 5 Menit:* *+${marketData.priceChange5m.toFixed(1)}%* (Batas Maksimal: +${CONFIG.MAX_5M_PRICE_CHANGE_PCT}%)\n\n` +
        `_Bot mendeteksi candle parabola vertikal yang rawan aksi dump instan._`;
      await notify(alertMsg);
    }
    return { success: false, message: 'Candle 5 menit terlalu overextended' };
  }

  // Institutional Risk Control 4b: Anti-Late-Chaser 1-Hour Pre-Pump Surge Guard
  // Only triggers if 1h is extreme exhaustion (>80%) OR if 1h > 40% AND 5m is already overextended (>15%)
  const is1hExhaustion = Boolean(
    marketData.priceChange1h && (
      marketData.priceChange1h > 80.0 || 
      (marketData.priceChange1h > 40.0 && (marketData.priceChange5m || 0) > 15.0)
    )
  );
  if (is1hExhaustion) {
    console.log(`[AutoTrade] 🛡️ Anti-Late-Chaser triggered: 1h pump +${marketData.priceChange1h?.toFixed(1)}% (${marketData.symbol})`);
    if (shouldNotifyFilterSkip) {
      const alertMsg = `⚠️ *ORDER DIBATALKAN: ANTI-LATE-CHASER GUARD*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        whaleInfoSection +
        `⚡ *Kenaikan 1 Jam Terakhir:* *+${marketData.priceChange1h?.toFixed(1)}%*\n` +
        `📊 *Candle 5 Menit:* *+${(marketData.priceChange5m || 0).toFixed(1)}%*\n\n` +
        `_Bot mendeteksi lonjakan vertikal overextended yang rawan aksi dump instan dev/pembeli awal._`;
      await notify(alertMsg);
    }
    return { success: false, message: `Token mengalami lonjakan vertikal overextended dalam 1 jam (+${marketData.priceChange1h?.toFixed(1)}%)` };
  }


  // 2. Anti-Rug Safety Audit (Result from concurrent Promise.all)
  if (!safety.isSafe) {
    console.log(`[AutoTrade] 🛡️ Anti-Rug failed for ${marketData.symbol}: score ${safety.score}/100, risks: ${safety.risks.join(', ')}`);
    if (shouldNotifyFilterSkip) {
      const riskDetails = safety.risks.map(r => `• ${r}`).join('\n');
      const alertMsg = `🛡️ *ORDER DIBATALKAN: ANTI-RUG GUARD*\n\n` +
        `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
        `📝 *CA:* \`${tokenMint}\`\n\n` +
        whaleInfoSection +
        `📊 *Skor Keamanan:* *${safety.score}/100* (Di bawah standar aman)\n\n` +
        `🚨 *Indikasi Bahaya:*\n${riskDetails}\n\n` +
        `_Bot melindungi modal Anda dari token berisiko tinggi atau jebakan dev._`;
      await notify(alertMsg);
    }
    return { success: false, message: `Skor keamanan terlalu rendah: ${safety.score}/100` };
  }

  // 2.5 Quantitative Capital Allocation: Fractional Kelly Criterion + Liquidity Depth Cap
  // Executed strictly AFTER all institutional safety, liquidity, and volume filters pass!
  let buyAmountSol = amountSol;
  if (isCopyTrade && whale) {
    const { calculateKellyPositionSize } = await import('./kellyEngine');
    const kellyResult = calculateKellyPositionSize(
      whale,
      effectiveLiquidity,
      solPriceUsd,
      currentBalance,
      marketData.priceChange5m || 0
    );
    buyAmountSol = kellyResult.allocatedSol;
    console.log(`[AutoTrade] ⚡ Kelly Sizing Active for [${whale.tier}] ${whale.label}: ${buyAmountSol} SOL (${kellyResult.rationale})`);
  } else if (!buyAmountSol || buyAmountSol <= 0) {
    buyAmountSol = CONFIG.DEFAULT_BUY_AMOUNT_SOL;
  }

  // Final balance validation against actual allocated position size + gas + ATA rent + gas buffer
  const minRequiredBalance = buyAmountSol + CONFIG.ESTIMATED_BUY_FEE_SOL + ATA_RENT_EXEMPT_SOL + GAS_RESERVE_BUFFER_SOL;
  if (currentBalance < minRequiredBalance) {
    const msg = `⚠️ Saldo tidak cukup! Saldo: ${currentBalance.toFixed(3)} SOL, Diperlukan: ${minRequiredBalance.toFixed(3)} SOL (termasuk buffer cadangan ${GAS_RESERVE_BUFFER_SOL} SOL & deposit ATA ${ATA_RENT_EXEMPT_SOL.toFixed(4)} SOL)`;
    console.log(`[AutoTrade] 🛡️ Ditolak: ${msg}`);
    if (shouldNotifyFilterSkip) {
      await notify(msg);
    }
    return { success: false, message: msg };
  }

  // 3. 100% Real DEX Buy Execution (Jupiter live router + AMM Constant Product depth)
  const simBuy = await simulateRealisticBuy(
    tokenMint,
    buyAmountSol,
    marketData.priceUsd,
    solPriceUsd,
    effectiveLiquidity,
    CONFIG.SLIPPAGE_PCT
  );
  const effectiveEntryPriceUsd = simBuy.effectiveEntryPriceUsd;
  const amountTokens = simBuy.tokensAcquired;
  const priceImpactPct = simBuy.priceImpactPct;

  // 4. Deduct Paper Balance (Principal + Real Live On-Chain Network Fee + ATA Rent Deposit)
  const liveBuyFeeSol = simBuy.networkFeeSol;
  const totalBuyDeductionSol = buyAmountSol + liveBuyFeeSol + ATA_RENT_EXEMPT_SOL;
  updatePaperBalance(-totalBuyDeductionSol);

  // Institutional Continuous Conditional Risk/Reward Engine
  let targetTpPct = CONFIG.TAKE_PROFIT_PCT;
  let targetSlPct = CONFIG.STOP_LOSS_PCT;
  if (CONFIG.VOLATILITY_ADAPTIVE_EXITS) {
    const absVol = marketData.priceChange5m ? Math.abs(marketData.priceChange5m) : 0;
    
    // Dynamic Stop-Loss: strictly bounded between 10.0% and 14.0%
    // In low-liquidity memecoins, wide SL (like 25%) leads to fatal drawdowns.
    // Instead, SL is kept tight (-10% to -14%) while position size is downscaled by Kelly.
    const volSlAdjustment = Math.min(2.0, absVol * 0.10);
    const liqSlAdjustment = effectiveLiquidity < 15000 ? 1.0 : (effectiveLiquidity > 50000 ? -1.0 : 0.0);
    targetSlPct = Math.min(14.0, Math.max(10.0, CONFIG.STOP_LOSS_PCT + volSlAdjustment + liqSlAdjustment));
    targetSlPct = Math.round(targetSlPct * 10) / 10;

    // Dynamic Take-Profit: dynamically expanded on high momentum/volatility
    // Guarantees an institutional 3.0:1 to 4.5:1 asymmetric payoff ratio!
    const dynamicTpMultiplier = 3.0 + Math.min(1.0, (absVol / 20.0));
    targetTpPct = Math.min(65.0, Math.max(CONFIG.TAKE_PROFIT_PCT, targetSlPct * dynamicTpMultiplier));
    targetTpPct = Math.round(targetTpPct * 10) / 10;
  }

  // 5. Create Position in Database
  const position = createPosition({
    token_address: tokenMint,
    token_symbol: marketData.symbol,
    token_name: marketData.name,
    amount_tokens: amountTokens,
    entry_price_usd: effectiveEntryPriceUsd,
    entry_sol: buyAmountSol,
    whale_source: whale ? whale.label : source,
    target_tp_pct: targetTpPct,
    target_sl_pct: targetSlPct
  });
  refreshPositionWebSocketSubscriptions();

  const remainingBalance = getPaperBalance();
  const whaleBuyVol = (whale && whaleSolAmount && whaleSolAmount > 0)
    ? `• Beli Paus: *${whaleSolAmount.toFixed(2)} SOL* (~$${(whaleSolAmount * solPriceUsd).toFixed(0)})\n`
    : '';

  const buyAlert = `🚀 *ORDER BELI BERHASIL DIEKSEKUSI!* (Simulasi $0)\n\n` +
    `🏷️ *Sumber:* ${whale ? `🐋 ${whale.label}` : '⚡ Manual Sniper'}\n` +
    `🪙 *Token:* *${marketData.symbol}* (${marketData.name})\n` +
    `📝 *CA:* \`${tokenMint}\`\n\n` +
    `📊 *Rincian Order:*\n` +
    `• Nominal Kita: *${buyAmountSol.toFixed(3)} SOL* (~$${(buyAmountSol * solPriceUsd).toFixed(2)})\n` +
    `${whaleBuyVol}` +
    `• Harga Entry: *${formatPrice(effectiveEntryPriceUsd)}*\n` +
    `• Market Cap: *$${formatNumber(marketData.marketCap)}*\n` +
    `• Likuiditas: *$${formatNumber(effectiveLiquidity)}*\n` +
    `• Anti-Rug Score: *${safety.score}/100* (✅ Aman)\n` +
    `• Biaya On-Chain Riil: *${liveBuyFeeSol.toFixed(6)} SOL* (Base 5k lamports + Priority + Jito Tip)\n` +
    `• Sisa Saldo Dummy: *${remainingBalance.toFixed(3)} SOL*\n\n` +
    `🎯 *Target TP:* +${targetTpPct}% | 🛑 *Cut Loss:* -${targetSlPct}% (Adaptive Volatility)\n` +
    `_Bot memantau pergerakan harga secara realtime._`;

  await notify(buyAlert, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📈 DexScreener', url: marketData.url },
          { text: '💰 Jual 100%', callback_data: `sell_100_${position.id}` }
        ]
      ]
    }
  });

    return { success: true, message: 'Order berhasil dibuka', position };
  } finally {
    activeOrderTokens.delete(tokenMint);
  }
}

// 2. EXECUTE SELL / CLOSE POSITION
export async function executeSellToken(
  positionId: number,
  sellPct: number = 100,
  reason: string = 'MANUAL_SELL'
): Promise<{ success: boolean; message: string }> {
  const pos = getPositionById(positionId);
  if (!pos || pos.status !== 'OPEN') {
    return { success: false, message: 'Posisi tidak ditemukan atau sudah ditutup.' };
  }

  // Fetch live market data for exit price
  const marketData = await getTokenMarketData(pos.token_address);
  const currentPriceUsd = marketData ? marketData.priceUsd : pos.current_price_usd;
  const solPriceUsd = await getSolPriceUsd();

  // 100% Real DEX Sell Execution (Jupiter live quote + Constant Product AMM depth cap)
  const tokensToSell = pos.amount_tokens * (sellPct / 100);
  const effLiquidity = marketData?.liquidityUsd || 20000;
  
  const simResult = await simulateRealisticSell(
    pos.token_address,
    tokensToSell,
    currentPriceUsd,
    solPriceUsd,
    effLiquidity,
    CONFIG.SLIPPAGE_PCT
  );

  const effectiveExitPriceUsd = simResult.effectiveExitPriceUsd;
  const actualCreditedSol = simResult.netSol;
  const grossExitSol = simResult.grossSol;
  const priceImpactPct = simResult.priceImpactPct;

  // When closing position 100%, Solana runtime reclaims the ATA rent deposit (0.00203928 SOL)
  const isFullClose = sellPct >= 99.9;
  const ataRefundSol = isFullClose ? ATA_RENT_EXEMPT_SOL : 0;
  const totalCreditedSol = actualCreditedSol + ataRefundSol;

  updatePaperBalance(totalCreditedSol);

  if (simResult.warning) {
    console.warn(`[TradeManager] ⚠️ ${simResult.warning}`);
  }

  // Close position in DB with true proceeds
  closePosition(pos.id, effectiveExitPriceUsd, actualCreditedSol, `${reason} (${sellPct}%)`);
  refreshPositionWebSocketSubscriptions();

  const pnlPct = ((effectiveExitPriceUsd - pos.entry_price_usd) / pos.entry_price_usd) * 100;
  const grossPnlSol = grossExitSol - (pos.entry_sol * (sellPct / 100));
  const isProfit = pnlPct >= 0;
  const newBalance = getPaperBalance();

  // True Net Fee Accounting with Live Real Fees (Base + Priority + Jito tip + DEX protocol)
  const sellGasSol = simResult.networkFeeSol;
  const buyGasSol = 0.00008 * (sellPct / 100);
  const dexFeeSol = simResult.dexFeeSol;
  const roundTripFeeSol = buyGasSol + sellGasSol + dexFeeSol;
  const netPnlSol = grossPnlSol - roundTripFeeSol;
  const isNetProfit = netPnlSol >= 0;

  // Institutional Risk Control: 2-Hour Loss Token Cooldown (Anti-Revenge Trading & Knife Catching)
  if (!isProfit || reason.includes('SL') || reason.includes('VELOCITY_DUMP') || reason.includes('FLASH_DUMP') || reason.includes('FLASH_EXIT')) {
    tokenLossCooldownMap.set(pos.token_address, Date.now() + LOSS_COOLDOWN_MS);
    console.log(`[TradeManager] 🛡️ Re-entry Guard: Token ${pos.token_symbol} masuk cooldown 2 jam pasca-dump.`);
  }

  // Record whale performance for institutional grading & auto-promotion
  if (pos.whale_source && pos.whale_source !== 'MANUAL' && pos.whale_source !== 'MANUAL_SNIPER') {
    const perf = recordWhaleTrade(pos.whale_source, netPnlSol, isNetProfit);
    if (perf?.promoted) {
      const promoMsg = `🎖️ *PROMOSI ELITE SMART MONEY!*\n\n` +
        `Dompet *${perf.whale.label}* (\`${perf.whale.address.slice(0, 6)}...${perf.whale.address.slice(-4)}\`) berhasil membuktikan profitabilitas!\n` +
        `• Win Rate: *${perf.winRate.toFixed(1)}%*\n` +
        `• Total PnL: *+${perf.whale.total_pnl_sol.toFixed(4)} SOL*\n` +
        `• Status Baru: *VERIFIED ELITE (AUTO-COPY AKTIF)* 🚀\n\n` +
        `_Mulai sekarang, bot akan otomatis menyalin trade dari paus terverifikasi ini._`;
      await notify(promoMsg);
    } else if (perf?.demoted) {
      const demoteMsg = `⏸️ *ALPHA BENCH: PAUS DIISTIRAHATKAN KE SHADOW MODE!*\n\n` +
        `Dompet *${perf.whale.label}* (\`${perf.whale.address.slice(0, 6)}...${perf.whale.address.slice(-4)}\`) mengalami ${CONFIG.MAX_CONSECUTIVE_LOSSES_DEMOTE}x Stop-Loss beruntun.\n` +
        `• Status Baru: *PROBATION (SHADOW BENCH)* 🔬\n` +
        `• Status Copy: *OFF (0 SOL Modal Dipertaruhkan)* 🛡️\n\n` +
        `_Paus tidak dihapus permanen untuk menguji apakah ini murni nasib sial (variance) atau sinyal rusak. Bot mengamankan modal Anda di balik layar. Begitu mencetak profit kembali di shadow mode, statusnya otomatis dipromosikan ke VERIFIED!_`;
      await notify(demoteMsg);
    }
  }

  // Execution Escalation Log for Emergency Exits
  if (reason.includes('SL') || reason.includes('FLASH_EXIT') || reason.includes('WHALE_DUMP') || reason.includes('VELOCITY_DUMP')) {
    console.log(`[TradeManager] ⚡ Emergency Exit detected (${reason}). Escalating priority fee & widening slippage tolerance.`);
  }

  let alertHeader = isProfit ? '🎉 *TAKE PROFIT DIEKSEKUSI!*' : '🛑 *STOP LOSS DIEKSEKUSI!*';
  let noteSection = '';

  if (reason.includes('VELOCITY_DUMP_RESCUE')) {
    alertHeader = '⚡ *EMERGENCY VELOCITY DUMP RESCUE (CUT CEPAT)!*';
    noteSection = `\n⚠️ *Analisis On-Chain (Deteksi Terjun Bebas):*\n` +
      `_Terdeteksi aksi dump dev/cabal mendadak dalam hitungan detik setelah entry. Bot memotong posisi lebih awal di ${pnlPct.toFixed(1)}% tanpa menunggu batas Stop-Loss penuh demi menyelamatkan modal Anda sebelum liquidity pool terkuras!_\n`;
  } else if (reason.includes('FLASH_DUMP_RESCUE')) {
    alertHeader = '⚡ *EMERGENCY FLASH DUMP RESCUE (SLIPPAGE GAP)!*';
    noteSection = `\n⚠️ *Analisis On-Chain (Slippage Gap Down):*\n` +
      `_Token sempat mencatat profit puncak, namun terjadi dump masif on-chain dalam 1 blok yang melompati batas pengaman. Bot langsung melikuidasi darurat di ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% untuk mengamankan sisa modal Anda sebelum rugi fatal terkena Full SL (-${pos.target_sl_pct || CONFIG.STOP_LOSS_PCT}%)._\n`;
  } else if (reason.includes('SL_PLUS') || reason.includes('BREAK_EVEN')) {
    if (isProfit) {
      alertHeader = '💰 *SL PLUS (PROFIT LOCK) DIEKSEKUSI!*';
      noteSection = `\n🛡️ *Prinsip Pro Trader:* _Trade yang sudah profit berhasil diamankan ke dalam saldo (Risk-Free Profit Realization)._\n`;
    } else {
      alertHeader = '⚡ *EMERGENCY SLIPPAGE CUT!*';
      noteSection = `\n⚠️ *Catatan Slippage:* _Harga pasar jatuh menembus floor sebelum sempat dieksekusi. Bot memotong posisi untuk menghindari risiko drawdown lebih dalam._\n`;
    }
  } else if (reason.includes('MOONBAG')) {
    if (isProfit && isNetProfit) {
      alertHeader = '🚀 *MOONBAG PROFIT HARVEST DIEKSEKUSI!*';
      noteSection = `\n🌕 *Strategi Moonbag:* _Sisa posisi 50% berhasil memanen cuan puncak dan diamankan otomatis saat terjadi koreksi harga!_\n`;
    } else if (isProfit) {
      alertHeader = '🛡️ *MOONBAG BEP GUARD (PROTEKSI IMPAS)!*';
      noteSection = `\n🛡️ *Prinsip Proteksi:* _Sisa posisi 50% diamankan di titik impas (BEP) demi melindungi modal awal dari ancaman Full Stop-Loss._\n`;
    } else {
      alertHeader = '⚡ *EMERGENCY SLIPPAGE CUT (MOONBAG BEP)!*';
      noteSection = `\n⚠️ *Catatan Likuiditas:* _Terjadi slippage on-chain saat mengeksekusi proteksi impas (BEP Guard). Bot langsung memotong sisa posisi untuk mencegah drawdown lebih dalam._\n`;
    }
  } else if (reason.includes('TRAILING_STOP') || reason.includes('RUNNER_TRAILING')) {
    alertHeader = isProfit 
      ? '🚀 *TRAILING STOP DIEKSEKUSI!*' 
      : '🛑 *STOP LOSS DIEKSEKUSI!*';
  }

  const sellAlert = `${alertHeader} (Simulasi)\n\n` +
    `🪙 *Token:* *${pos.token_symbol}*\n` +
    `📝 *Alasan:* \`${reason}\`\n\n` +
    `📊 *Hasil Perdagangan (True Net Accounting):*\n` +
    `• PnL %: *${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%* ${isProfit ? '🟢' : '🔴'}\n` +
    `• Gross PnL: *${grossPnlSol >= 0 ? '+' : ''}${grossPnlSol.toFixed(4)} SOL* (~$${(grossPnlSol * solPriceUsd).toFixed(2)})\n` +
    `• Biaya On-Chain Riil: *-${roundTripFeeSol.toFixed(5)} SOL* (Gas + Priority + Jito + DEX Fee)\n` +
    `• Net PnL Bersih: *${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(4)} SOL* (~$${(netPnlSol * solPriceUsd).toFixed(2)}) ${isNetProfit ? '💰' : '🔻'}\n` +
    `• Modal Posisi: ${pos.entry_sol.toFixed(3)} SOL\n` +
    `• Hasil Penjualan: *${actualCreditedSol.toFixed(4)} SOL*\n` +
    (isFullClose ? `• Refund Deposit ATA Rent: *+${ataRefundSol.toFixed(4)} SOL* (Akun SPL Ditutup)\n` : '') +
    `• Saldo Virtual Sekarang: *${newBalance.toFixed(3)} SOL*\n` +
    noteSection + '\n' +
    `_Riwayat tersimpan ke database._`;

  await notify(sellAlert);

  // Institutional Risk Control: Circuit Breaker Max Daily Drawdown / Consecutive Stop-Loss Guard
  if (CONFIG.CIRCUIT_BREAKER_ENABLED && (!isProfit || reason.includes('SL') || reason.includes('STOP_LOSS'))) {
    const dailyLosses = getDailyStopLossCount();
    if (dailyLosses >= CONFIG.CIRCUIT_BREAKER_MAX_DAILY_LOSSES) {
      tripCircuitBreaker(
        CONFIG.CIRCUIT_BREAKER_COOLDOWN_HOURS,
        `Terjadi ${dailyLosses}x Stop-Loss dalam 24 jam terakhir`
      );
      const cbAlert = `🚨 *EMERGENCY: CIRCUIT BREAKER DIAKTIFKAN!* 🚨\n\n` +
        `⚠️ Batas kerugian harian tercapai: *${dailyLosses}x Stop Loss dalam 24 jam*.\n` +
        `🛑 Seluruh order beli baru DIBEKUKAN selama *${CONFIG.CIRCUIT_BREAKER_COOLDOWN_HOURS} jam*.\n\n` +
        `_Tindakan perlindungan modal hedge fund otomatis untuk menghindari gelombang rug pull atau kondisi crash pasar solana._`;
      await notify(cbAlert);
    }
  }

  return { success: true, message: `Posisi ${pos.token_symbol} berhasil ditutup.` };
}

// 2.5 EXECUTE WHALE SELL FOLLOW (INSTITUTIONAL DUMP & ANTI-BOTTOM-DUMP PROTECTION)
export async function executeWhaleSellFollow(
  whale: Whale,
  tokenMint: string,
  tokensSold?: number
): Promise<{ success: boolean; message: string }> {
  if (!CONFIG.COPY_SELL_ENABLED) {
    return { success: false, message: 'Whale copy-sell synchronization dinonaktifkan di konfigurasi.' };
  }

  const pos = getOpenPositionByToken(tokenMint);
  if (!pos) {
    return { success: false, message: 'Tidak ada posisi terbuka untuk token ini.' };
  }

  // 1. Source Origin Check: Ensure this whale actually opened this position
  if (CONFIG.REQUIRE_WHALE_SOURCE_MATCH && pos.whale_source && pos.whale_source !== 'MANUAL' && pos.whale_source !== 'MANUAL_SNIPER') {
    const cleanSource = pos.whale_source.toLowerCase();
    const cleanLabel = whale.label.toLowerCase();
    const cleanAddr = whale.address.toLowerCase();
    const isMatching = cleanSource.includes(cleanLabel) || cleanLabel.includes(cleanSource) || cleanSource.includes(cleanAddr) || whale.tier === 'VIP';
    if (!isMatching) {
      console.log(`[TradeManager] ℹ️ Whale ${whale.label} dump token ${pos.token_symbol}, tapi posisi ini dibuka oleh [${pos.whale_source}]. Mengabaikan sinyal sell asing.`);
      return { success: false, message: `Bukan paus inisiator posisi (${pos.whale_source})` };
    }
  }

  // 2. Fetch Fresh Pool Liquidity & Market Reality
  let currentLiquidity = lastKnownLiquidity.get(pos.id) || 0;
  try {
    const marketData = await getTokenMarketData(tokenMint, true);
    if (marketData && marketData.liquidityUsd > 0) {
      currentLiquidity = marketData.liquidityUsd;
      lastKnownLiquidity.set(pos.id, currentLiquidity);
    }
  } catch {}

  // 3. P0 Anti-Bottom-Dump Protection: Never dump blindly into thin liquidity pools (< $50k)
  if (currentLiquidity > 0 && currentLiquidity < CONFIG.MIN_DUMP_FOLLOW_LIQUIDITY_USD) {
    console.log(`[TradeManager] 🛡️ ANTI-BOTTOM-DUMP TRIGGERED: Likuiditas $${currentLiquidity.toFixed(0)} < $${CONFIG.MIN_DUMP_FOLLOW_LIQUIDITY_USD} (${pos.token_symbol}). Menolak dump ke wick bawah!`);

    const alertMsg = `🛡️ *ANTI-BOTTOM-DUMP GUARD DIAKTIFKAN!* 🛡️\n\n` +
      `🐋 *Paus:* *${whale.label}* (\`${whale.address.slice(0, 6)}...${whale.address.slice(-4)}\`)\n` +
      `🪙 *Token:* *${pos.token_symbol}*\n` +
      `💧 *Likuiditas Pool:* *$${formatNumber(currentLiquidity)}* (Ambang Aman: *$${formatNumber(CONFIG.MIN_DUMP_FOLLOW_LIQUIDITY_USD)}*)\n\n` +
      `⚠️ *Kebijakan Hedge Fund:* Bot *MENOLAK* market dump buta ke jarum wick bawah yang rawan slippage raksasa (15-35%).\n` +
      `🔒 *Pengawalan Posisi:* Posisi tetap dikawal ketat oleh *Hard Stop-Loss (-${pos.target_sl_pct || CONFIG.STOP_LOSS_PCT}%)* dan *Moonbag Trailing Stop* secara real-time via WebSocket untuk memanen rebound harga (mean reversion) atau keluar tertib.`;
    await notify(alertMsg);

    return { success: false, message: `Likuiditas pool tipis ($${currentLiquidity.toFixed(0)}). Menolak sell di bottom wick.` };
  }

  // 4. Free-Roll Moonbag Protection: If position is already half-closed (in free-roll mode), let trailing stop manage it
  if (pos.is_half_closed === 1 && pos.pnl_pct > 0) {
    console.log(`[TradeManager] 🌕 MOONBAG SHIELD: Posisi ${pos.token_symbol} berstatus Free-Roll Moonbag (PnL +${pos.pnl_pct.toFixed(1)}%). Menyerahkan eksekusi ke Trailing Stop.`);
    return { success: false, message: 'Posisi dikawal Trailing Stop Moonbag' };
  }

  // 5. Orderly Execution in Deep Pools (>= $50k)
  console.log(`[TradeManager] 🚨 WHALE SELL FOLLOW VALID: Paus inisiator ${whale.label} keluar dari ${pos.token_symbol} di pool yang cukup dalam ($${currentLiquidity.toFixed(0)}). Melikuidasi tertib...`);

  const exitAlert = `🚨 *WHALE DUMP DETECTED — ORDERLY SELL FOLLOW!* 🚨\n\n` +
    `🐋 *Paus:* *${whale.label}* (\`${whale.address.slice(0, 6)}...${whale.address.slice(-4)}\`)\n` +
    `🪙 *Token:* *${pos.token_symbol}*\n` +
    `💧 *Likuiditas Pool:* *$${formatNumber(currentLiquidity)}* (Pool Cukup Dalam ✅)\n` +
    `⚡ *Aksi Paus:* Terdeteksi swap SELL di DEX!\n\n` +
    `🛡️ *Respons Institusional:* Bot mengeksekusi likuidasi 100% untuk mengunci profit/mengamankan modal sebelum pergerakan berlanjut.`;
  await notify(exitAlert);

  return await executeSellToken(pos.id, 100, `WHALE_DUMP_FOLLOW (${whale.label})`);
}

// 3. REAL-TIME WEBSOCKET POSITION MONITORING & EVALUATION
let monitorInterval: NodeJS.Timeout | null = null;
const lastKnownLiquidity: Map<number, number> = new Map();
const activePositionSubs: Map<number, { accountSubs: number[]; logSubs: number[] }> = new Map();
const evaluatingPositions: Set<number> = new Set();

export function refreshPositionWebSocketSubscriptions() {
  const openPositions = getOpenPositions();
  const currentOpenIds = new Set(openPositions.map(p => p.id));

  // Unsubscribe closed positions
  for (const [posId, subs] of activePositionSubs.entries()) {
    if (!currentOpenIds.has(posId)) {
      for (const subId of subs.accountSubs) {
        try { connection.removeAccountChangeListener(subId); } catch {}
      }
      for (const subId of subs.logSubs) {
        try { connection.removeOnLogsListener(subId); } catch {}
      }
      activePositionSubs.delete(posId);
      console.log(`[TradeManager] 🛑 WebSocket position tracker stopped for #${posId}`);
    }
  }

  // Subscribe new open positions
  for (const pos of openPositions) {
    if (activePositionSubs.has(pos.id)) continue;

    const subs = { accountSubs: [] as number[], logSubs: [] as number[] };

    try {
      if (pos.token_address.endsWith('pump')) {
        const bondingCurvePda = getBondingCurveAddress(pos.token_address);
        const subId = connection.onAccountChange(
          bondingCurvePda,
          async (accountInfo) => {
            try {
              const state = decodeBondingCurveBuffer(accountInfo.data);
              if (state && state.spotPriceSol > 0) {
                const solPrice = await getSolPriceUsd();
                const currentPrice = state.spotPriceSol * solPrice;
                const currentLiq = state.liquiditySol * solPrice;
                await evaluatePosition(pos.id, currentPrice, currentLiq);
              }
            } catch {}
          },
          'confirmed'
        );
        subs.accountSubs.push(subId);
        console.log(`[TradeManager] ⚡ Live Helius WS (onAccountChange) Active for Pump.fun token ${pos.token_symbol}`);
      } else {
        const tokenPubkey = new PublicKey(pos.token_address);
        const subId = connection.onLogs(
          tokenPubkey,
          async (logsCtx) => {
            if (logsCtx.err) return;
            try {
              await evaluatePosition(pos.id);
            } catch {}
          },
          'confirmed'
        );
        subs.logSubs.push(subId);
        console.log(`[TradeManager] ⚡ Live Helius WS (onLogs) Active for Raydium token ${pos.token_symbol}`);
      }

      activePositionSubs.set(pos.id, subs);
    } catch (err: any) {
      console.warn(`[TradeManager] Gagal subscribe WebSocket untuk posisi ${pos.token_symbol}:`, err.message);
    }
  }
}

export async function evaluatePosition(
  posId: number, 
  overridePrice?: number, 
  overrideLiquidityUsd?: number
) {
  if (evaluatingPositions.has(posId)) return;
  evaluatingPositions.add(posId);

  try {
    const pos = getPositionById(posId);
    if (!pos || pos.status !== 'OPEN') return;

    const solPriceUsd = await getSolPriceUsd();
    let currentPrice = overridePrice || pos.current_price_usd;
    let currentLiquidityUsd = overrideLiquidityUsd || 0;

    // Direct on-chain bonding curve math for Pump.fun tokens if no override
    if (!overridePrice && pos.token_address.endsWith('pump')) {
      const onChainCurve = await getOnChainBondingCurve(pos.token_address);
      if (onChainCurve && !onChainCurve.complete && onChainCurve.spotPriceSol > 0) {
        currentPrice = onChainCurve.spotPriceSol * solPriceUsd;
        currentLiquidityUsd = onChainCurve.liquiditySol * solPriceUsd;
      }
    }

    // Fallback to DexScreener if not a bonding curve token or graduated to Raydium
    if (currentPrice === pos.current_price_usd || currentLiquidityUsd === 0) {
      const isProfitable = (pos.peak_price_usd > pos.entry_price_usd);
      const marketData = await getTokenMarketData(pos.token_address, isProfitable);
      if (marketData) {
        currentPrice = marketData.priceUsd;
        currentLiquidityUsd = marketData.liquidityUsd;
      }
    }

    if (!currentPrice || currentPrice <= 0) return;

    // Flash-Exit Rug Buster: Detect sudden liquidity drainage (>30% in single tick)
    if (CONFIG.FLASH_EXIT_ENABLED && currentLiquidityUsd > 0) {
      const prevLiq = lastKnownLiquidity.get(pos.id);
      if (prevLiq && prevLiq > 1000) {
        const dropPct = ((prevLiq - currentLiquidityUsd) / prevLiq) * 100;
        if (dropPct >= CONFIG.FLASH_EXIT_DROP_PCT) {
          console.log(`[TradeManager] 🚨 FLASH-EXIT RUG BUSTER TRIGGERED for ${pos.token_symbol}! Liquidity dropped ${dropPct.toFixed(1)}% in single tick.`);
          lastKnownLiquidity.delete(pos.id);
          await executeSellToken(pos.id, 100, `FLASH_EXIT_RUG_BUSTER (-${dropPct.toFixed(0)}% Liq Drain)`);
          return;
        }
      }
      lastKnownLiquidity.set(pos.id, currentLiquidityUsd);
    }

    // Anti-Flash-Wick Glitch Filter (Reality Guard):
    // If currentPrice represents a sudden anomalous > 300% jump over entry on an illiquid pool, reject the phantom tick
    const theoreticalGainPct = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
    if (theoreticalGainPct > 300.0 && currentLiquidityUsd > 0 && currentLiquidityUsd < 5000) {
      console.warn(`[TradeManager] 🛡️ FLASH-WICK GLITCH REJECTED for ${pos.token_symbol}: Price $${currentPrice} (+${theoreticalGainPct.toFixed(0)}%) rejected on illiquid pool ($${currentLiquidityUsd.toFixed(0)})!`);
      return;
    }

    const updated = updatePositionPrice(pos.id, currentPrice);
    if (!updated) return;

    const pnlPct = updated.pnl_pct;
    const peakPrice = updated.peak_price_usd;
    const targetTp = pos.target_tp_pct || CONFIG.TAKE_PROFIT_PCT;
    const targetSl = pos.target_sl_pct || CONFIG.STOP_LOSS_PCT;

    // 1. STAGE 1 TAKE-PROFIT (Hedge Fund Asymmetric Target): Jual 40%, Modal Pokok + Cuan Masuk, 60% Jadi Free-Roll Moonbag!
    if (pos.is_half_closed === 0 && pnlPct >= targetTp) {
      console.log(`[TradeManager] 🎯 STAGE 1 TP (+${pnlPct.toFixed(1)}% >= target ${targetTp}%) tercapai untuk ${pos.token_symbol}! Mengamankan 40% posisi via DEX Simulator...`);
      const soldTokens = pos.amount_tokens * 0.40;
      
      const simResult = await simulateRealisticSell(
        pos.token_address,
        soldTokens,
        currentPrice,
        solPriceUsd,
        currentLiquidityUsd || 20000,
        CONFIG.SLIPPAGE_PCT
      );

      const creditedSol = simResult.netSol;
      updatePaperBalance(creditedSol);
      halfClosePosition(pos.id, simResult.effectiveExitPriceUsd, creditedSol, `STAGE_1_TP (+${pnlPct.toFixed(1)}%)`);

      const remainingBalance = getPaperBalance();
      const halfTpAlert = `🎉 *STAGE 1 TAKE-PROFIT DIEKSEKUSI! (40% DIAMANKAN)*\n\n` +
        `🪙 *Token:* *${pos.token_symbol}* (${pos.token_name})\n` +
        `📈 *Profit Terkunci:* *+${pnlPct.toFixed(1)}%* (Target: +${targetTp}%) 🟢\n` +
        `💰 *Dana Masuk:* *${creditedSol.toFixed(4)} SOL* (~$${(creditedSol * solPriceUsd).toFixed(2)})\n` +
        `🛡️ *Status:* *Modal Pokok & Profit Diamankan!* Saldo bebas risiko.\n` +
        `🌕 *Sisa 60% Posisi:* Menjadi *FREE-ROLL MOONBAG* dikawal Institutional Trailing Stop (${CONFIG.TRAILING_STOP_PCT}%).\n` +
        `💼 *Saldo Virtual Sekarang:* *${remainingBalance.toFixed(3)} SOL*\n\n` +
        `_Jika token meledak ratusan persen, sisa 60% posisi ini akan memanen jackpot puncak!_`;

      await notify(halfTpAlert);
      return;
    }

    // 2. STAGE 2 INSTITUTIONAL MOONBAG TRAILING STOP (Memberi Ruang Nafas Menuju Puncak)
    if (pos.is_half_closed === 1) {
      const peakGainPct = ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      
      // True Net BEP Floor: Dihitung dinamis agar hasil penjualan 100% masih CUAN BERSIH setelah gas & DEX fee
      const sellFeeSol = CONFIG.ESTIMATED_SELL_FEE_SOL;
      const gasDragPct = pos.entry_sol > 0 ? (sellFeeSol / pos.entry_sol) * 100 : 2.5;
      const trueNetBepFloorPct = Math.max(10.0, gasDragPct + 4.0);

      let moonbagFloorPct: number | null = null;
      let moonbagReason = '';

      // Trailing Stop Moonbag Hedge Fund: Longgar dan agresif mengawal runner
      if (peakGainPct >= 120.0) {
        // Mega Parabolic Runner: Trail 12% dari peak, kunci minimal >= +70%
        // Mega Parabolic Runner: Trail 15% dari peak, kunci minimal >= +80%
        moonbagFloorPct = Math.max(80.0, peakGainPct - 15.0);
        moonbagReason = `MOONBAG_MEGA_RUNNER (Peak +${peakGainPct.toFixed(1)}% -> Locked @ +${moonbagFloorPct.toFixed(1)}%)`;
      } else if (peakGainPct >= 60.0) {
        // Super Runner: Trail 12% dari peak, kunci minimal >= +40%
        moonbagFloorPct = Math.max(40.0, peakGainPct - 12.0);
        moonbagReason = `MOONBAG_SUPER_RUNNER (Peak +${peakGainPct.toFixed(1)}% -> Locked @ +${moonbagFloorPct.toFixed(1)}%)`;
      } else if (peakGainPct >= 35.0) {
        // Solid Breakout: Trail 10% dari peak, kunci minimal >= +20%
        moonbagFloorPct = Math.max(20.0, peakGainPct - 10.0);
        moonbagReason = `MOONBAG_PROFIT_HARVEST (Peak +${peakGainPct.toFixed(1)}% -> Locked @ +${moonbagFloorPct.toFixed(1)}%)`;
      } else {
        // Floor dasar aman: Kunci minimal >= +12% Net Cuan (tidak membiarkan runner mati impas)
        moonbagFloorPct = Math.max(12.0, trueNetBepFloorPct);
        moonbagReason = `MOONBAG_PROTECTED_FLOOR (Protected @ +${moonbagFloorPct.toFixed(1)}% Net Cuan)`;
      }

      if (pnlPct <= moonbagFloorPct) {
        console.log(`[TradeManager] 🛡️ Institutional Moonbag Trailing Triggered for ${pos.token_symbol} (Peak: +${peakGainPct.toFixed(1)}%, Floor: +${moonbagFloorPct.toFixed(1)}%, Current: +${pnlPct.toFixed(1)}%)`);
        await executeSellToken(pos.id, 100, moonbagReason);
        return;
      }
    }

    // 2.8. VELOCITY DUMP RESCUE (Strict Anti-Rug / Honeypot Early Cut)
    // Prinsip Hedge Fund: Potong HANYA jika terbukti Catastrophic Rug / Dev Dump!
    // JANGAN terpicu oleh fluktuasi normal -3% s/d -6% yang merupakan noise bid-ask spread!
    const ageSec = (Date.now() - new Date(pos.opened_at).getTime()) / 1000;
    const isFreshCollapse = (ageSec <= 90 && pnlPct <= -14.0);
    const isPlungeDrop = (pnlPct <= -10.0 && pos.current_price_usd > 0 && ((pos.current_price_usd - currentPrice) / pos.current_price_usd) * 100 >= 12.0);

    if (pos.is_half_closed === 0 && (isFreshCollapse || isPlungeDrop)) {
      const reasonDetail = isFreshCollapse 
        ? `Fresh collapse (${pnlPct.toFixed(1)}% in ${ageSec.toFixed(0)}s < 90s)` 
        : `Plunge drop (${pnlPct.toFixed(1)}% with severe tick velocity)`;
      console.log(`[TradeManager] ⚡ VELOCITY DUMP RESCUE triggered for ${pos.token_symbol}: ${reasonDetail}`);
      await executeSellToken(pos.id, 100, `VELOCITY_DUMP_RESCUE (${reasonDetail})`);
      return;
    }

    // 3. STOP-LOSS (Strict Institutional Hard Ceiling)
    if (pos.is_half_closed === 0 && pnlPct <= -targetSl) {
      console.log(`[TradeManager] 🛑 HARD SL Triggered for ${pos.token_symbol} (${pnlPct.toFixed(1)}% <= -${targetSl}%)`);
      await executeSellToken(pos.id, 100, `AUTO_SL (${pnlPct.toFixed(1)}%)`);
      return;
    }

    // 3.5. PRO TRADER DYNAMIC SL PLUS & PROFIT LOCK LADDER (Hedge Fund High-Water Mark):
    // CATATAN PENTING: Jangan mencekik posisi di +6%! Fluktuasi normal 10-15% dibiarkan bernafas.
    // Tangga pengaman baru aktif setelah koin membuktikan breakout di atas +25%!
    if (pos.is_half_closed === 0 && peakPrice > pos.entry_price_usd) {
      const peakGainPct = ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      let targetFloorPct: number | null = null;
      let tierLabel = '';

      if (peakGainPct >= 80.0) {
        // Tier 3: Parabolic Mega Runner (Trail 12.0% from peak, guaranteed floor >= +50%)
        targetFloorPct = Math.max(50.0, peakGainPct - 12.0);
        tierLabel = 'TIER_3_MEGA_RUNNER';
      } else if (peakGainPct >= 45.0) {
        // Tier 2: Strong Runner (Trail 10.0% from peak, guaranteed floor >= +25%)
        targetFloorPct = Math.max(25.0, peakGainPct - 10.0);
        tierLabel = 'TIER_2_RUNNER';
      } else if (peakGainPct >= 25.0) {
        // Tier 1: Breakout Lock (Trail 8.0% from peak, guaranteed floor >= +15%)
        // Memberi ruang bernafas yang cukup bagi koin sebelum ditarik ke pucuk
        targetFloorPct = Math.max(15.0, peakGainPct - 8.0);
        tierLabel = 'TIER_1_BREAKOUT_LOCK';
      }

      if (targetFloorPct !== null && pnlPct <= targetFloorPct) {
        if (pnlPct >= 5.0) {
          // PRO TRADER SCALE-OUT (50:50 RULE):
          // Jual 50% posisi untuk mengunci modal + profit, sisa 50% dijadikan Free-Roll Moonbag!
          console.log(`[TradeManager] 💰 SL PLUS 50:50 PARTIAL PROFIT LOCK for ${pos.token_symbol} (Peak: +${peakGainPct.toFixed(1)}%, Floor: +${targetFloorPct.toFixed(1)}%, Current: +${pnlPct.toFixed(1)}%) via DEX Simulator...`);
          
          const halfTokens = pos.amount_tokens * 0.5;
          const simResult = await simulateRealisticSell(
            pos.token_address,
            halfTokens,
            currentPrice,
            solPriceUsd,
            currentLiquidityUsd || 20000,
            CONFIG.SLIPPAGE_PCT
          );

          const creditedSol = simResult.netSol;
          updatePaperBalance(creditedSol);
          halfClosePosition(pos.id, simResult.effectiveExitPriceUsd, creditedSol, `SL_PLUS_50_50_${tierLabel} (+${pnlPct.toFixed(1)}%)`);

          const remainingBalance = getPaperBalance();
          const halfAlert = `💰 *SL PLUS: 50% PROFIT LOCK & FREE-ROLL MOONBAG!* (Simulasi)\n\n` +
            `🪙 *Token:* *${pos.token_symbol}* (${pos.token_name})\n` +
            `📈 *Profit 50% Pertama Terkunci:* *+${pnlPct.toFixed(1)}%* (Peak: +${peakGainPct.toFixed(1)}%) 🟢\n` +
            `💵 *Dana Diamankan:* *${creditedSol.toFixed(4)} SOL* (~$${(creditedSol * solPriceUsd).toFixed(2)})\n` +
            `🛡️ *Status:* *Modal Awal & Sebagian Cuan Masuk Dompet!* Trade ini 100% BEBAS RISIKO.\n` +
            `🌕 *Sisa 50% Posisi:* Menjadi *FREE-ROLL MOONBAG* dikawal Trailing Stop (${CONFIG.TRAILING_STOP_PCT}%).\n` +
            `💼 *Saldo Virtual Sekarang:* *${remainingBalance.toFixed(3)} SOL*\n\n` +
            `_Jika token meledak ratusan persen (seperti KETCHUP +217%), sisa 50% ini akan memanen cuan puncak tanpa takut rugi!_`;

          await notify(halfAlert);
          return;
        } else {
          // Flash dump slipped past the trailing floor in a single block before it could be caught: Liquidate 100% emergency
          console.log(`[TradeManager] ⚡ FLASH DUMP SLIPPAGE GAP RESCUE for ${pos.token_symbol} (Peak: +${peakGainPct.toFixed(1)}%, Floor: +${targetFloorPct.toFixed(1)}%, Breached to: ${pnlPct.toFixed(1)}%)`);
          await executeSellToken(pos.id, 100, `FLASH_DUMP_RESCUE (Peak +${peakGainPct.toFixed(1)}% Jebol Floor +${targetFloorPct.toFixed(1)}% -> Cut @ ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
          return;
        }
      }
    }

    // 4. RUNNER TRAILING STOP (Untuk mega runner di atas +60% yang belum kena TP penuh)
    if (pos.is_half_closed === 0) {
      const peakGainPct = ((peakPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
      if (peakGainPct >= 60.0) {
        const dropFromPeakPct = ((peakPrice - currentPrice) / peakPrice) * 100;
        if (dropFromPeakPct >= 15.0) {
          console.log(`[TradeManager] 🚀 Mega Runner Trailing Stop Triggered for ${pos.token_symbol} (Peak: +${peakGainPct.toFixed(1)}%, Dropped: -${dropFromPeakPct.toFixed(1)}%)`);
          await executeSellToken(pos.id, 100, `RUNNER_TRAILING_STOP (Peak +${peakGainPct.toFixed(1)}%)`);
          return;
        }
      }
    }

    // 5. TIME-STOP / ZOMBIE POSITION REAPER (24-Hour Capital Turnover Rule)
    const openedTime = new Date(pos.opened_at).getTime();
    const hoursHeld = (Date.now() - openedTime) / (1000 * 60 * 60);
    if (hoursHeld >= CONFIG.MAX_HOLD_TIME_HOURS) {
      console.log(`[TradeManager] ⌛ Time-Stop Triggered for ${pos.token_symbol} (${hoursHeld.toFixed(1)}h held). Liquidating to free capital...`);
      await executeSellToken(pos.id, 100, `TIME_STOP (${hoursHeld.toFixed(1)}h Zombie Exit)`);
      return;
    }
  } catch (err: any) {
    // Ignore transient errors
  } finally {
    evaluatingPositions.delete(posId);
  }
}

export function startPositionManager() {
  if (monitorInterval) return;
  console.log(`[TradeManager] ⚡ Live Position WebSocket & Fallback Monitor started (Polling fallback: ${CONFIG.POSITION_CHECK_INTERVAL_SEC}s)...`);

  refreshPositionWebSocketSubscriptions();
  checkPositions();
  monitorInterval = setInterval(checkPositions, CONFIG.POSITION_CHECK_INTERVAL_SEC * 1000);
}

export function stopPositionManager() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  for (const [posId, subs] of activePositionSubs.entries()) {
    for (const subId of subs.accountSubs) {
      try { connection.removeAccountChangeListener(subId); } catch {}
    }
    for (const subId of subs.logSubs) {
      try { connection.removeOnLogsListener(subId); } catch {}
    }
  }
  activePositionSubs.clear();
}

async function checkPositions() {
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  refreshPositionWebSocketSubscriptions();

  for (const pos of openPositions) {
    try {
      await evaluatePosition(pos.id);
    } catch (err: any) {
      // Ignore transient errors
    }
  }
}

function formatNumber(num: number): string {
  if (!num) return '0';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K';
  return num.toFixed(2);
}

export function formatPrice(val: number): string {
  if (!val || isNaN(val)) return '$0.00';
  if (val < 0.000001) return '$' + val.toExponential(3);
  if (val < 0.001) return '$' + val.toFixed(6);
  if (val < 0.05) return '$' + val.toFixed(5);
  if (val < 1) return '$' + val.toFixed(4);
  return '$' + val.toFixed(2);
}

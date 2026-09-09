import { CONFIG } from './config';
import { initDatabase, getPaperBalance } from './db/index';
import { bot } from './bot/telegram';
import { startWhaleTracker, stopWhaleTracker, setWhaleTradeHandler } from './services/tracker';
import { startPositionManager, stopPositionManager, executeBuyToken, executeWhaleSellFollow } from './services/tradeManager';
import { startWhaleScout, stopWhaleScout } from './services/whaleScout';

async function main() {
  console.log('====================================================');
  console.log(' 🚀 SOLANA SMART MONEY & AUTO-SNIPER TRADING BOT   ');
  console.log('====================================================');

  // 1. Initialize SQLite Database
  initDatabase();
  console.log(`[DB] Database initialized successfully. Paper Balance: ${getPaperBalance().toFixed(3)} SOL`);

  // 2. Connect Whale Tracker to Institutional Auto-Trade Manager (Buy & Sell Sync)
  setWhaleTradeHandler(async (whale, tokenMint, action, solAmount, txSignature, tokenAmount) => {
    if (action === 'BUY') {
      console.log(`[AutoTrade] 🐋 Whale Buy Event: [${whale.tier || 'VERIFIED'}] ${whale.label} bought token ${tokenMint} (${solAmount} SOL)`);

      if (whale.tier === 'PROBATION' || !whale.auto_copy) {
        console.log(`[AutoTrade] 🔬 Whale ${whale.label} berstatus [PROBATION] (Shadow Mode). Mencatat token observasi ${tokenMint} tanpa risiko modal.`);
        try {
          const { getTokenMarketData } = await import('./services/dexscreener');
          const { addShadowWatch } = await import('./db/index');
          const market = await getTokenMarketData(tokenMint);
          if (market && market.priceUsd > 0) {
            addShadowWatch(whale.address, whale.label, tokenMint, market.priceUsd);
          }
        } catch {}
        return;
      }

      // God-Tier Quantitative Capital Allocation: Fractional Kelly Criterion + Liquidity Depth Cap
      const balance = getPaperBalance();
      const { getSolPriceUsd, getTokenMarketData } = await import('./services/dexscreener');
      const { calculateKellyPositionSize } = await import('./services/kellyEngine');
      const solPrice = await getSolPriceUsd();

      let poolLiquidityUsd = 10000;
      let volatility5mPct = 0;
      let market: any = null;
      try {
        market = await getTokenMarketData(tokenMint);
        if (market) {
          if (market.liquidityUsd > 0) poolLiquidityUsd = market.liquidityUsd;
          if (market.priceChange5m !== undefined) volatility5mPct = market.priceChange5m;
        }
      } catch {}

      const kellyResult = calculateKellyPositionSize(whale, poolLiquidityUsd, solPrice, balance, volatility5mPct);
      const positionSizeSol = kellyResult.allocatedSol;

      console.log(`[AutoTrade] ⚡ Kelly Sizing Active for [${whale.tier}] ${whale.label}: ${positionSizeSol} SOL (${kellyResult.rationale})`);

      let whaleEntryPriceUsd: number | undefined = undefined;
      if (tokenAmount && tokenAmount > 0) {
        try {
          whaleEntryPriceUsd = (solAmount * solPrice) / tokenAmount;
        } catch {}
      }

      await executeBuyToken(tokenMint, positionSizeSol, 'COPY_TRADE', whale, whaleEntryPriceUsd, market || undefined);
    } else if (action === 'SELL') {
      console.log(`[AutoTrade] 🚨 Whale Sell Event: [${whale.tier || 'VERIFIED'}] ${whale.label} dumped token ${tokenMint} (${tokenAmount || 0} tokens)`);

      // Check if this whale was in probation and had a shadow watch on this token
      try {
        const { getActiveShadowWatch, closeShadowWatch, closeAllShadowWatchesForWhale, promoteWhale, recordWhaleTrade } = await import('./db/index');
        // Only evaluate and promote if the whale is currently in PROBATION
        if (whale.tier === 'PROBATION') {
          const shadow = getActiveShadowWatch(whale.address, tokenMint);
          if (shadow) {
            const { getTokenMarketData } = await import('./services/dexscreener');
            const market = await getTokenMarketData(tokenMint);
            if (market && market.priceUsd > 0) {
              const pnlPct = ((market.priceUsd - shadow.entry_price_usd) / shadow.entry_price_usd) * 100;
              closeAllShadowWatchesForWhale(whale.address);
              console.log(`[WhaleScout] 🔬 Shadow Trade Evaluated for ${whale.label}: Token ${market.symbol} PnL: ${pnlPct.toFixed(2)}%`);

              if (pnlPct >= 2.0) {
                promoteWhale(whale.address);
                whale.tier = 'VERIFIED';
                whale.auto_copy = 1;
                console.log(`[WhaleScout] 🎖️ PROMOSI: Whale ${whale.label} lolos audisi shadow mode (+${pnlPct.toFixed(1)}% profit)! Status -> VERIFIED`);
                const promoMsg = `🎓 *KANDIDAT SMART MONEY LOLOS AUDISI SHADOW MODE!*\n\n` +
                  `Dompet *${whale.label}* (\`${whale.address.slice(0, 6)}...${whale.address.slice(-4)}\`) berhasil membuktikan profitabilitas di pasar on-chain!\n` +
                  `• Token Uji Coba: *${market.symbol}*\n` +
                  `• Hasil Trade: *+${pnlPct.toFixed(1)}% PROFIT* 🟢\n` +
                  `• Status Baru: *VERIFIED (AUTO-COPY AKTIF)* 🚀\n\n` +
                  `_Mulai sekarang, bot akan otomatis menyalin setiap order beli dari paus ini._`;
                const { bot } = await import('./bot/telegram');
                if (CONFIG.TELEGRAM_ADMIN_ID) {
                  bot.telegram.sendMessage(CONFIG.TELEGRAM_ADMIN_ID, promoMsg, { parse_mode: 'Markdown' }).catch(() => {});
                }
              } else if (pnlPct < -10) {
                recordWhaleTrade(whale.address, -0.01, false);
              }
            }
          }
        }
      } catch {}


      await executeWhaleSellFollow(whale, tokenMint, tokenAmount);
    }
  });

  // 3. Start Background Loops
  startPositionManager();
  startWhaleTracker();
  startWhaleScout();

  // 4. Start Telegram Bot
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    console.warn('\n⚠️ [Telegram] PERINGATAN: TELEGRAM_BOT_TOKEN belum diatur di file .env.');
    console.warn('👉 Buat bot baru di https://t.me/BotFather, salin tokennya, lalu masukkan ke file .env.\n');
  } else {
    try {
      const me = await bot.telegram.getMe();
      console.log(`[Telegram] 🤖 Bot online: @${me.username} (${me.first_name})`);
      
      // Start polling non-blocking
      bot.launch({ dropPendingUpdates: true }).catch((err) => {
        console.error('[Telegram] Polling error:', err.message);
      });
      console.log(`[Telegram] 🚀 Polling aktif. Bot siap menerima pesan di Telegram!`);
    } catch (err: any) {
      console.error('[Telegram] ❌ Gagal menghubungkan bot Telegram:', err.message);
      console.warn('Pastikan TELEGRAM_BOT_TOKEN di .env sudah valid.');
    }
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[System] Shutting down cleanly...');
    stopPositionManager();
    stopWhaleTracker();
    stopWhaleScout();
    bot.stop();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal Error]:', err);
  process.exit(1);
});

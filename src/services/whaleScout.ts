import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import { CONFIG } from '../config';
import { 
  addWhale, 
  removeWhale, 
  getAllWhales, 
  getActiveWhales, 
  getWhaleByAddress, 
  getWhalesForPruning,
  addToWhaleQueue,
  getWhaleQueue,
  promoteQueueWhaleToActive,
  isWhaleBlacklisted,
  blacklistWhale 
} from '../db/index';
import { refreshWhaleSubscriptions } from './tracker';
import { getTokenMarketData } from './dexscreener';
import { isCabalSuspect } from './cabalDetector';
import { connection } from './solanaConnection';

type TelegramNotifier = (message: string, extra?: any) => Promise<void>;
let scoutNotifier: TelegramNotifier | null = null;

export function setScoutNotifier(notifier: TelegramNotifier) {
  scoutNotifier = notifier;
}

async function notify(message: string, extra?: any) {
  if (scoutNotifier) {
    try {
      await scoutNotifier(message, extra);
    } catch (err: any) {
      console.error('[WhaleScout PRO] Gagal mengirim notifikasi Telegram:', err.message);
    }
  }
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

// Filter out common system / AMM program addresses so they aren't recruited as whales
const SYSTEM_BLACKLIST = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  'So11111111111111111111111111111111111111112',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'routeUGWgpak9pq3bvCj2sMgT1TKHBiQG3UtDhVe9dB', // Raydium Router
]);

// ============================================================================
// SMART MONEY CONVERGENCE ENGINE
// ============================================================================

/**
 * Represents a single wallet that has passed all 6 screening gates for a given token.
 */
export interface SmartMoneyCandidate {
  address: string;
  label: string;
  archetype: string;
  balanceSol: number;
  solSpent: number;          // Amount of SOL spent in this buy
  winRate: number;           // From Helius pre-screen (0-100), 0 if unknown
  totalTrades: number;       // Number of historical trades audited
  pastTxCount: number;       // Total historical tx count on-chain
  isMigrationInsider: boolean;
}

/**
 * In-memory buffer: tokenMint → list of qualified smart money candidates.
 * Accumulated during a single scout run — cleared after each run.
 */
const tokenSmartMoneyMap: Map<string, SmartMoneyCandidate[]> = new Map();

/**
 * Computes a composite Smart Money Score (SMS) for a token based on:
 * - Number of independent smart wallets that entered (convergence multiplier)
 * - Quality of each wallet (win rate weighted by buy size)
 * - Bonus for migration insider status
 *
 * Score formula:
 *   SMS = (convergenceCount ^ 1.5) × avgWeightedWinRate × migrationBonus
 *
 * Thresholds (configurable):
 *   >= 80 : 🏆 CONVICTION (2+ wallets, high WR)  → ALERT + auto-recruit top wallet
 *   >= 50 : ⚡ STRONG SIGNAL (single elite wallet, or 2 moderate)
 *   < 50  : 🔬 WEAK SIGNAL (observe only)
 */
export function computeSmartMoneyScore(candidates: SmartMoneyCandidate[]): {
  score: number;
  tier: 'CONVICTION' | 'STRONG' | 'WEAK';
  convergenceCount: number;
  avgWinRate: number;
  totalSolEntered: number;
  bestCandidate: SmartMoneyCandidate;
} {
  const convergenceCount = candidates.length;

  // Weighted win rate: weight by SOL size of each buy (bigger buyer's WR matters more)
  const totalSol = candidates.reduce((s, c) => s + c.solSpent, 0);
  const weightedWinRate = totalSol > 0
    ? candidates.reduce((s, c) => s + (c.winRate * c.solSpent), 0) / totalSol
    : candidates.reduce((s, c) => s + c.winRate, 0) / convergenceCount;

  // Migration insider bonus: wallets that bought during initial pool minutes are highest quality
  const migrationCount = candidates.filter(c => c.isMigrationInsider).length;
  const migrationBonus = 1.0 + (migrationCount * 0.15); // +15% per insider

  // Score formula: convergence ^ 1.5 × avgWR × migrationBonus / 10 (normalize to 0-100)
  const rawScore = (Math.pow(convergenceCount, 1.5) * weightedWinRate * migrationBonus) / 10;
  const score = Math.min(100, Math.round(rawScore));

  const tier: 'CONVICTION' | 'STRONG' | 'WEAK' =
    score >= 80 ? 'CONVICTION' :
    score >= 50 ? 'STRONG' : 'WEAK';

  // Best candidate = highest win rate among those with most SOL spent
  const bestCandidate = [...candidates].sort((a, b) =>
    (b.winRate * b.solSpent) - (a.winRate * a.solSpent)
  )[0];

  return { score, tier, convergenceCount, avgWinRate: weightedWinRate, totalSolEntered: totalSol, bestCandidate };
}

/**
 * Institutional Latency & MEV Disqualification:
 * Rejects high-frequency micro-flipping bots (holding time < 90s or excessive failure rate).
 */
export async function isMevBotSuspect(walletAddress: string, signatures: any[]): Promise<{ isMev: boolean; reason: string }> {
  if (!signatures || signatures.length < 5) {
    return { isMev: false, reason: 'Insufficient tx history to classify MEV' };
  }

  // 1. Failure rate check (Spam sniper bots often have > 65% failed txs)
  const failedCount = signatures.filter(s => s.err !== null).length;
  const failureRatePct = (failedCount / signatures.length) * 100;
  if (failureRatePct >= 65.0) {
    return { isMev: true, reason: `Tingkat kegagalan transaksi ${failureRatePct.toFixed(0)}% (Karakteristik spam sniper bot)` };
  }

  // 2. Inter-transaction spacing check (Sub-minute flipping)
  const blockTimes = signatures.map(s => s.blockTime).filter(bt => bt !== null && bt !== undefined) as number[];
  if (blockTimes.length >= 4) {
    let rapidIntervals = 0;
    for (let i = 0; i < blockTimes.length - 1; i++) {
      const diffSec = Math.abs(blockTimes[i] - blockTimes[i + 1]);
      if (diffSec < CONFIG.MIN_WHALE_HOLDING_SEC) {
        rapidIntervals++;
      }
    }
    if (rapidIntervals / (blockTimes.length - 1) >= 0.6) {
      return { isMev: true, reason: `Holding time ultra-pendek / transaksi beruntun (<${CONFIG.MIN_WHALE_HOLDING_SEC}s)` };
    }
  }

  return { isMev: false, reason: 'Human smart money profile' };
}

// ============================================================================
// PILAR 2: Pre-Screen Historical Win Rate (Institutional-Grade Candidate Audit)
// ============================================================================
/**
 * Analyzes the last N transactions of a wallet to assess whether they are
 * a profitable smart money trader. Checks win rate, avg profit, and avg hold time.
 * Returns null on any error (treated as inconclusive / pass).
 */
export async function assessWhaleCandidateWinRate(
  walletAddress: string,
  heliusApiKey: string
): Promise<{ winRate: number; avgHoldSec: number; totalTrades: number; passed: boolean; reason: string } | null> {
  try {
    // Use Helius Enhanced Transactions API for clean parsed tx data
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${heliusApiKey}&limit=20&type=SWAP`;
    const res = await axios.get(url, { timeout: 8000 });
    const txs: any[] = res.data || [];

    if (txs.length < 5) {
      return { winRate: 100, avgHoldSec: 9999, totalTrades: txs.length, passed: true, reason: 'Riwayat SWAP tidak cukup (< 5), dianggap bersih' };
    }

    // Analyze token events: track SOL spent vs. SOL received per swap
    let wins = 0;
    let losses = 0;
    let holdTimeSamples: number[] = [];

    for (const tx of txs) {
      const events = tx.events?.swap;
      if (!events) continue;

      // Native SOL balance change (negative = spent, positive = received)
      const nativeDiff = tx.nativeTransfers?.reduce((sum: number, t: any) => {
        if (t.toUserAccount === walletAddress) return sum + t.amount;
        if (t.fromUserAccount === walletAddress) return sum - t.amount;
        return sum;
      }, 0) ?? 0;

      // A net positive SOL means they sold for profit, negative means they bought
      if (nativeDiff > 0) {
        wins++;
      } else if (nativeDiff < -0.001 * 1e9) {
        losses++;
      }

      if (tx.timestamp) holdTimeSamples.push(tx.timestamp);
    }

    const totalTrades = wins + losses;
    if (totalTrades < 3) {
      return { winRate: 100, avgHoldSec: 9999, totalTrades, passed: true, reason: 'Tidak cukup data swap SOL terukur, dianggap bersih' };
    }

    const winRate = (wins / totalTrades) * 100;

    // Compute average hold time between buys
    let avgHoldSec = 9999;
    if (holdTimeSamples.length >= 2) {
      holdTimeSamples.sort((a, b) => a - b);
      let totalHold = 0;
      for (let i = 1; i < holdTimeSamples.length; i++) {
        totalHold += holdTimeSamples[i] - holdTimeSamples[i - 1];
      }
      avgHoldSec = totalHold / (holdTimeSamples.length - 1);
    }

    const minWinRate = CONFIG.WHALE_MIN_PRESCREEN_WINRATE || 55.0;
    const passed = winRate >= minWinRate;
    const reason = passed
      ? `Win Rate ${winRate.toFixed(1)}% >= ${minWinRate}% (${wins}W/${losses}L dari ${totalTrades} trade)`
      : `Win Rate ${winRate.toFixed(1)}% < ${minWinRate}% (${wins}W/${losses}L dari ${totalTrades} trade)`;

    return { winRate, avgHoldSec, totalTrades, passed, reason };
  } catch (err: any) {
    // If Helius API call fails, skip pre-screen (don't block candidate)
    console.warn(`[WhaleScout PRO] Win rate pre-screen gagal untuk ${walletAddress.slice(0, 8)}: ${err.message} — dilanjutkan tanpa filter`);
    return null;
  }
}

// ============================================================================
// PILAR 1: Raydium Migration Scanner — koin fresh baru live dari Pump.fun
// ============================================================================
/**
 * Discovers recently migrated Pump.fun → Raydium pools (< WHALE_MIGRATION_MAX_AGE_MIN minutes old).
 * These are the highest-alpha venues where early buyers are most likely to be insiders.
 */
export async function getRecentMigrationTokens(
  maxAgeMins: number = CONFIG.WHALE_MIGRATION_MAX_AGE_MIN || 45
): Promise<Array<{ tokenMint: string; poolName: string; volumeUsd: number; poolAgeMins: number }>> {
  const results: Array<{ tokenMint: string; poolName: string; volumeUsd: number; poolAgeMins: number }> = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - maxAgeMins * 60;

  try {
    // DexScreener boosted / latest pairs on Raydium (sorted by creation time)
    const res = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=sol&rankBy=trendingScoreH1&order=desc',
      { timeout: 7000 }
    );
    const pairs: any[] = res.data?.pairs || [];

    for (const p of pairs) {
      if (results.length >= 12) break;
      if (p.chainId !== 'solana') continue;
      if (!['raydium', 'raydium-clmm', 'raydium-cpmm'].includes(p.dexId)) continue;

      const pairCreatedAtSec = p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : 0;
      if (pairCreatedAtSec < cutoffSec) continue; // Too old

      const liqUsd = p.liquidity?.usd || 0;
      const volH1 = p.volume?.h1 || 0;
      const volH24 = p.volume?.h24 || 0;
      const tokenMint = p.baseToken?.address;

      // Quality gate: min $10k liquidity and some early trading activity
      if (!tokenMint || liqUsd < 10000 || (volH1 + volH24) < 2000) continue;
      if (tokenMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') continue; // USDC
      if (tokenMint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') continue; // USDT

      const poolAgeMins = Math.floor((nowSec - pairCreatedAtSec) / 60);
      if (!results.some(r => r.tokenMint === tokenMint)) {
        results.push({
          tokenMint,
          poolName: `${p.baseToken?.symbol || '?'}/SOL [Raydium Migration ${poolAgeMins}m ago]`,
          volumeUsd: volH24,
          poolAgeMins
        });
      }
    }
  } catch (err: any) {
    console.warn('[WhaleScout PRO] Migration scanner fallback (DexScreener error):', err.message);
  }

  // Fallback: Raydium new pairs API
  if (results.length < 4) {
    try {
      const res = await axios.get(
        'https://api.raydium.io/v2/main/pairs?sortBy=volume&sortType=desc&poolType=all&poolSortField=default&page=1&pageSize=30',
        { timeout: 6000 }
      );
      const pairs: any[] = res.data?.data || [];
      for (const p of pairs) {
        if (results.length >= 12) break;
        const tokenMint = p.baseMint;
        if (!tokenMint || results.some(r => r.tokenMint === tokenMint)) continue;
        const liq = p.liquidity || 0;
        const vol = p.volume24h || 0;
        if (liq < 10000 || vol < 5000) continue;
        results.push({
          tokenMint,
          poolName: `${p.name || '?'} [Raydium New]`,
          volumeUsd: vol,
          poolAgeMins: 0
        });
      }
    } catch {}
  }

  console.log(`[WhaleScout PRO] 🚀 Raydium Migration Scanner: ${results.length} fresh pool ditemukan (max ${maxAgeMins}m lalu).`);
  return results;
}

// ============================================================================
// PILAR 5: Multi-Source Token Discovery
// ============================================================================
/**
 * Fetches top organic volume tokens from multiple institutional-grade sources:
 * 1. Raydium New Pools (fresh migrations)
 * 2. Birdeye Trending Tokens
 * 3. DexScreener High-Volume Pairs (< 1 jam, to catch early movers)
 * 4. GeckoTerminal Trending Pools (fallback / broad market)
 */
export async function getOrganicTrendingTokens(limit: number = 16): Promise<Array<{ tokenMint: string; poolName: string; volumeUsd: number }>> {
  const tokens: Array<{ tokenMint: string; poolName: string; volumeUsd: number }> = [];

  // ── Tier 1: Migration tokens (fresh Raydium pools) ──
  if (CONFIG.WHALE_MIGRATION_SCAN_ENABLED) {
    try {
      const migrationTokens = await getRecentMigrationTokens();
      for (const m of migrationTokens) {
        if (tokens.length >= limit) break;
        if (!tokens.some(t => t.tokenMint === m.tokenMint)) {
          tokens.push({ tokenMint: m.tokenMint, poolName: m.poolName, volumeUsd: m.volumeUsd });
        }
      }
    } catch {}
  }

  // ── Tier 2: Birdeye Trending Tokens on Solana ──
  if (tokens.length < limit) {
    try {
      const res = await axios.get(
        'https://public-api.birdeye.so/defi/trending_tokens?sort_by=volume24hUSD&sort_type=desc&limit=10&chain=solana',
        {
          headers: { Accept: 'application/json', 'x-chain': 'solana' },
          timeout: 6000
        }
      );
      const items: any[] = res.data?.data?.items || [];
      for (const item of items) {
        if (tokens.length >= limit) break;
        const tokenMint = item.address;
        const volumeUsd = item.volume24hUSD || 0;
        const liqUsd = item.liquidity || 0;
        if (
          tokenMint &&
          volumeUsd >= 50000 &&
          liqUsd >= 15000 &&
          !tokens.some(t => t.tokenMint === tokenMint) &&
          tokenMint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' &&
          tokenMint !== 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
        ) {
          tokens.push({ tokenMint, poolName: `${item.symbol || '?'} [Birdeye Trending]`, volumeUsd });
        }
      }
    } catch (err: any) {
      console.warn('[WhaleScout PRO] Birdeye trending unavailable:', err.message);
    }
  }

  // ── Tier 3: DexScreener < 1 hour old active pairs (early mover alpha) ──
  if (tokens.length < limit) {
    try {
      const res = await axios.get(
        'https://api.dexscreener.com/latest/dex/search?q=solana&rankBy=trendingScoreH1&order=desc',
        { timeout: 6000 }
      );
      const pairs: any[] = (res.data?.pairs || []).filter((p: any) =>
        p.chainId === 'solana' &&
        (p.volume?.h1 || 0) >= 15000 &&
        (p.liquidity?.usd || 0) >= 15000
      );
      for (const p of pairs) {
        if (tokens.length >= limit) break;
        const tokenMint = p.baseToken?.address;
        if (tokenMint && !tokens.some(t => t.tokenMint === tokenMint)) {
          tokens.push({
            tokenMint,
            poolName: `${p.baseToken?.symbol || 'SOL'} / ${p.quoteToken?.symbol || 'SOL'} [DexScreener H1]`,
            volumeUsd: p.volume?.h24 || 0
          });
        }
      }
    } catch {}
  }

  // ── Tier 4: GeckoTerminal Trending Pools (broad market fallback) ──
  if (tokens.length < limit) {
    try {
      const res = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools', {
        headers: { Accept: 'application/json' },
        timeout: 7000
      });

      const pools = res.data?.data;
      if (Array.isArray(pools)) {
        for (const p of pools) {
          if (tokens.length >= limit) break;
          const rawTokenId = p.relationships?.base_token?.data?.id || '';
          const tokenMint = rawTokenId.replace('solana_', '');
          const volumeUsd = parseFloat(p.attributes?.volume_usd?.h24 || '0');
          const reserveUsd = parseFloat(p.attributes?.reserve_in_usd || '0');
          const poolName = p.attributes?.name || 'GeckoTerminal Pool';

          if (
            tokenMint &&
            tokenMint.length >= 32 &&
            reserveUsd >= 10000 &&
            volumeUsd >= 50000 &&
            tokenMint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' &&
            tokenMint !== 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
          ) {
            if (!tokens.some(t => t.tokenMint === tokenMint)) {
              tokens.push({ tokenMint, poolName: `${poolName} [GeckoTerminal]`, volumeUsd });
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[WhaleScout PRO] GeckoTerminal unavailable:', err.message);
    }
  }

  // ── Tier 5: DexScreener broad fallback if still not enough ──
  if (tokens.length < limit) {
    try {
      const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 6000 });
      const pairs = res.data?.pairs?.filter((p: any) =>
        p.chainId === 'solana' &&
        (p.volume?.h24 || 0) >= 100000 &&
        (p.liquidity?.usd || 0) >= 15000
      ) || [];
      for (const p of pairs) {
        if (tokens.length >= limit) break;
        const tokenMint = p.baseToken?.address;
        if (tokenMint && !tokens.some(t => t.tokenMint === tokenMint)) {
          tokens.push({
            tokenMint,
            poolName: `${p.baseToken?.symbol || 'SOL'} / ${p.quoteToken?.symbol || 'SOL'} [DexScreener H24]`,
            volumeUsd: p.volume?.h24 || 0
          });
        }
      }
    } catch {}
  }

  return tokens;
}

export interface ScoutOutcome {
  recruited: number;
  queued: number;
  isFull: boolean;
  totalWhales: number;
  maxWhales: number;
  queueLength: number;
}

/**
 * PRO SCANNER: Auto-Scan & Recruit Smart Money Whales
 * 5-Pillar Institutional Grade Whale Discovery System + Smart Money Convergence Engine
 *
 * Key upgrade: Instead of recruiting the first qualifying wallet per token,
 * we now accumulate ALL qualified wallets per token, compute a composite
 * Smart Money Score (convergence × win rate × buy size), then recruit the
 * BEST candidate from the highest-conviction token first.
 */
export async function scoutTrendingWhales(limitToRecruit: number = CONFIG.WHALE_SCOUT_BATCH_SIZE || 4): Promise<ScoutOutcome> {
  console.log('[WhaleScout PRO] 🔍 Memulai pemindaian Smart Money Convergence Engine (6-Gate + SMS Score)...');
  
  const currentWhales = getAllWhales();
  const currentQueue = getWhaleQueue();
  const isRosterFull = currentWhales.length >= CONFIG.MAX_ACTIVE_WHALES;

  if (isRosterFull && currentQueue.length >= 50) {
    console.log(`[WhaleScout PRO] ℹ️ Radar (${currentWhales.length}/${CONFIG.MAX_ACTIVE_WHALES}) dan queue (${currentQueue.length}/50) penuh.`);
    return {
      recruited: 0,
      queued: 0,
      isFull: true,
      totalWhales: currentWhales.length,
      maxWhales: CONFIG.MAX_ACTIVE_WHALES,
      queueLength: currentQueue.length
    };
  }

  let recruitedCount = 0;
  let queuedCount = 0;

  // Clear convergence buffer for this run
  tokenSmartMoneyMap.clear();

  // Get Helius API key for enhanced transaction parsing (Pilar 4)
  const heliusApiKey = CONFIG.HELIUS_API_KEYS[0] || CONFIG.HELIUS_API_KEY || '';

  try {
    // ── PILAR 1 + 5: Multi-Source Token Discovery ──
    const targetTokens = await getOrganicTrendingTokens(18);
    if (targetTokens.length === 0) {
      console.log('[WhaleScout PRO] ⚠️ Tidak ada token ditemukan. Retry berikutnya.');
      return {
        recruited: 0, queued: 0, isFull: isRosterFull,
        totalWhales: currentWhales.length, maxWhales: CONFIG.MAX_ACTIVE_WHALES, queueLength: currentQueue.length
      };
    }

    // ── PHASE 1: Accumulate qualified smart money candidates per token ──
    // We scan ALL target tokens first (without recruiting) to build convergence map.
    for (const tokenItem of targetTokens) {
      const tokenMint = tokenItem.tokenMint;
      const isMigration = tokenItem.poolName.includes('Raydium Migration') || tokenItem.poolName.includes('Raydium New');
      const isBirdeye = tokenItem.poolName.includes('Birdeye');

      console.log(`[WhaleScout PRO] 🔎 Phase 1 Scan: ${tokenItem.poolName} CA: \`${tokenMint.slice(0, 8)}...\``);

      const market = await getTokenMarketData(tokenMint);
      const symbol = market ? market.symbol : 'TOKEN';

      // ── PILAR 4: Deep scan 50 signatures per pool ──
      let sigs: any[] = [];
      try {
        sigs = await connection.getSignaturesForAddress(new PublicKey(tokenMint), {
          limit: CONFIG.WHALE_SCOUT_SIGNATURES_DEPTH || 50
        });
      } catch (err: any) {
        console.warn(`[WhaleScout PRO] Gagal ambil sigs untuk ${tokenMint}:`, err.message);
        continue;
      }

      const candidateSeen = new Set<string>();

      for (const sigInfo of sigs) {
        if (sigInfo.err) continue;
        await sleep(60);

        try {
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0
          });
          if (!tx || !tx.meta) continue;

          const firstAccount = tx.transaction.message.accountKeys[0];
          const feePayerKey = firstAccount?.pubkey ? firstAccount.pubkey.toBase58() : null;

          if (!feePayerKey) continue;
          if (SYSTEM_BLACKLIST.has(feePayerKey)) continue;
          if (isWhaleBlacklisted(feePayerKey)) continue;
          if (getWhaleByAddress(feePayerKey)) continue;
          if (candidateSeen.has(feePayerKey)) continue;
          candidateSeen.add(feePayerKey);

          // Must be a net buyer
          const post = tx.meta.postTokenBalances?.find(b => b.owner === feePayerKey && b.mint === tokenMint);
          const pre = tx.meta.preTokenBalances?.find(b => b.owner === feePayerKey && b.mint === tokenMint);
          if ((parseFloat(post?.uiTokenAmount?.uiAmountString || '0')) <= (parseFloat(pre?.uiTokenAmount?.uiAmountString || '0'))) continue;

          // ── Gate 1: SOL balance ──
          const balanceLamports = await connection.getBalance(new PublicKey(feePayerKey));
          const balanceSol = balanceLamports / 1_000_000_000;
          if (balanceSol < CONFIG.MIN_WHALE_BALANCE_SOL) continue;

          // ── Gate 2: Buy size ──
          const preSol = tx.meta.preBalances[0] || 0;
          const postSol = tx.meta.postBalances[0] || 0;
          const solSpent = (preSol - postSol) / 1_000_000_000;
          if (solSpent < CONFIG.MIN_WHALE_BUY_SOL) continue;

          // ── Gate 3: Anti-burner (tx history depth) ──
          const pastSigs = await connection.getSignaturesForAddress(new PublicKey(feePayerKey), { limit: 25 });
          if (pastSigs.length < CONFIG.MIN_WHALE_HISTORY_TXS) continue;

          // ── Gate 4: MEV / HFT bot filter ──
          const mevCheck = await isMevBotSuspect(feePayerKey, pastSigs);
          if (mevCheck.isMev) {
            console.log(`[WhaleScout PRO] 🤖 MEV: ${feePayerKey.slice(0, 8)} — ${mevCheck.reason}`);
            continue;
          }

          // ── Gate 5: Cabal / Sybil cluster ──
          const cabalCheck = await isCabalSuspect(feePayerKey, getAllWhales());
          if (cabalCheck.isCabal) {
            console.log(`[WhaleScout PRO] 🚨 CABAL: ${feePayerKey.slice(0, 8)} — shared funder: ${cabalCheck.matchingWhales.join(', ')}`);
            continue;
          }

          // ── Gate 6: Historical win rate pre-screen ──
          let winRate = 60; // default assumption if Helius unavailable
          let totalTrades = 0;
          if (heliusApiKey) {
            const wr = await assessWhaleCandidateWinRate(feePayerKey, heliusApiKey);
            if (wr !== null) {
              if (!wr.passed && wr.totalTrades >= 5) {
                console.log(`[WhaleScout PRO] 📉 WR FAIL: ${feePayerKey.slice(0, 8)} — ${wr.reason}`);
                continue;
              }
              winRate = wr.winRate;
              totalTrades = wr.totalTrades;
            }
          }

          // ── All 6 Gates Passed: Add to convergence map ──
          let archetype = '🎯 RAYDIUM_HUNTER';
          let label = `🎯 Scout: $${symbol} Smart Buyer`;

          if (balanceSol >= CONFIG.VIP_WHALE_BALANCE_SOL) {
            archetype = '👑 VIP_ACCUMULATOR_CANDIDATE';
            label = `👑 Paus: $${symbol} VIP Accumulator`;
          } else if (isMigration) {
            archetype = '🚀 MIGRATION_INSIDER';
            label = `🚀 Insider: $${symbol} Migration Buyer`;
          } else if (isBirdeye) {
            archetype = '⚡ MOMENTUM_SWING';
            label = `⚡ Smart: $${symbol} Momentum Whale`;
          } else if (market?.priceChange24h && market.priceChange24h > 100) {
            archetype = '🐋 EARLY_ACCUMULATOR';
            label = `🐋 Paus: $${symbol} Early Accumulator`;
          }

          const candidate: SmartMoneyCandidate = {
            address: feePayerKey,
            label,
            archetype,
            balanceSol,
            solSpent,
            winRate,
            totalTrades,
            pastTxCount: pastSigs.length,
            isMigrationInsider: isMigration
          };

          const existing = tokenSmartMoneyMap.get(tokenMint) || [];
          existing.push(candidate);
          tokenSmartMoneyMap.set(tokenMint, existing);

          console.log(`[WhaleScout PRO] ✅ LOLOS 6-GATE: ${feePayerKey.slice(0,8)} → ${archetype} | WR:${winRate.toFixed(0)}% | ${solSpent.toFixed(3)} SOL spent | Convergence[${tokenMint.slice(0,6)}]: ${existing.length}`);
        } catch {
          // ignore individual tx parse errors
        }
      }
    }

    // ── PHASE 2: Score & rank tokens by Smart Money Convergence ──
    // Sort tokens by SMS score descending — recruit from highest conviction first.
    const scoredTokens: Array<{
      tokenMint: string;
      tokenItem: typeof targetTokens[0];
      smsResult: ReturnType<typeof computeSmartMoneyScore>;
    }> = [];

    for (const tokenItem of targetTokens) {
      const candidates = tokenSmartMoneyMap.get(tokenItem.tokenMint);
      if (!candidates || candidates.length === 0) continue;
      const smsResult = computeSmartMoneyScore(candidates);
      scoredTokens.push({ tokenMint: tokenItem.tokenMint, tokenItem, smsResult });
    }

    // Sort by score descending
    scoredTokens.sort((a, b) => b.smsResult.score - a.smsResult.score);

    console.log(`[WhaleScout PRO] 📊 Phase 2 SMS Scoring: ${scoredTokens.length} token dengan qualified wallets.`);
    for (const t of scoredTokens) {
      const { score, tier, convergenceCount, avgWinRate } = t.smsResult;
      const symbol = (await getTokenMarketData(t.tokenMint))?.symbol || 'TOKEN';
      console.log(`[WhaleScout PRO]   ${tier === 'CONVICTION' ? '🏆' : tier === 'STRONG' ? '⚡' : '🔬'} ${symbol}: SMS ${score}/100 (Conv: ${convergenceCount} wallets, Avg WR: ${avgWinRate.toFixed(0)}%) [${tier}]`);
    }

    // ── PHASE 3: Recruit from highest-conviction tokens ──
    for (const { tokenMint, tokenItem, smsResult } of scoredTokens) {
      if ((recruitedCount + queuedCount) >= limitToRecruit) break;

      const { score, tier, convergenceCount, avgWinRate, totalSolEntered, bestCandidate } = smsResult;
      const candidates = tokenSmartMoneyMap.get(tokenMint)!;
      const market = await getTokenMarketData(tokenMint);
      const symbol = market?.symbol || 'TOKEN';
      const isMigration = tokenItem.poolName.includes('Raydium Migration') || tokenItem.poolName.includes('Raydium New');
      const isBirdeye = tokenItem.poolName.includes('Birdeye');

      // For WEAK signals with only 1 unscreened wallet, still recruit but mark PROBATION strictly
      const tierEmoji = tier === 'CONVICTION' ? '🏆' : tier === 'STRONG' ? '⚡' : '🔬';
      const sourceTag = isMigration ? '🚀 *Raydium Migration*' : isBirdeye ? '📊 *Birdeye Trending*' : '📈 *High-Volume Pool*';

      // Send convergence alert if multiple wallets detected
      if (convergenceCount >= 2) {
        const convMsg = `${tierEmoji} *KONVERGENSI SMART MONEY TERDETEKSI!* ${tier === 'CONVICTION' ? '🔥' : ''}

` +
          `📊 *Token:* *$${symbol}* | ${sourceTag}
` +
          `📝 *CA:* \`${tokenMint}\`
` +
          `🧠 *Smart Money Score:* *${score}/100* [*${tier}*]
` +
          `👥 *Jumlah Smart Wallet Masuk:* *${convergenceCount} wallet independen*
` +
          `💰 *Total SOL Masuk:* *${totalSolEntered.toFixed(2)} SOL*
` +
          `📈 *Rata-rata Win Rate:* *${avgWinRate.toFixed(1)}%*
` +
          `🏆 *Wallet Terbaik:* \`${bestCandidate.address.slice(0,8)}...\` (WR: ${bestCandidate.winRate.toFixed(0)}%, beli ${bestCandidate.solSpent.toFixed(2)} SOL)

` +
          `_Bot merekrut wallet dengan score terbaik dari kelompok ini sebagai signal anchor._`;
        await notify(convMsg);
      }

      // Recruit the best candidate from this token's convergence group
      const feePayerKey = bestCandidate.address;

      if (getAllWhales().length < CONFIG.MAX_ACTIVE_WHALES) {
        const added = addWhale(feePayerKey, bestCandidate.label, CONFIG.DEFAULT_BUY_AMOUNT_SOL, 0, 'PROBATION');

        if (added) {
          recruitedCount++;
          console.log(`[WhaleScout PRO] 🎯 DIREKRUT (SMS ${score}/100 [${tier}]): ${bestCandidate.label} | Conv:${convergenceCount} | AvgWR:${avgWinRate.toFixed(0)}%`);

          const recruitMsg = `🏛️ *SMART MONEY DIREKRUT (SMS SCORE: ${score}/100 [${tier}])* ✅

` +
            `🏷️ *Label:* ${bestCandidate.label}
` +
            `📝 *Alamat:* \`${feePayerKey}\`
` +
            `🏆 *Arketipe:* *${bestCandidate.archetype}*
` +
            `💰 *Saldo On-Chain:* *${bestCandidate.balanceSol.toFixed(2)} SOL*
` +
            `📊 *Win Rate Historical:* *${bestCandidate.winRate.toFixed(0)}%* (${bestCandidate.totalTrades} swaps)
` +
            `👥 *Konvergensi:* *${convergenceCount} smart wallet* masuk token yang sama
` +
            `💸 *Total SOL Kelompok:* *${totalSolEntered.toFixed(2)} SOL*
` +
            `⚡ *Gate MEV:* ✅ | 🛡️ *Gate Cabal:* ✅ | 📈 *Gate WR:* ✅
` +
            `🪙 *Pool Acuan:* ${sourceTag} — *$${symbol}* (Vol $${(tokenItem.volumeUsd / 1_000_000).toFixed(2)}M)
` +
            `🛡️ *Status Copy:* *OFF (Shadow Track)*

` +
            `_💡 Bot memantau konvergensi ${convergenceCount} trader berhistoris kuat di token ini secara real-time._`;

          await notify(recruitMsg);
        }
      } else {
        // Active roster full → shadow queue with SMS score bonus
        const queued = addToWhaleQueue({
          address: feePayerKey,
          label: bestCandidate.label,
          archetype: bestCandidate.archetype,
          balanceSol: bestCandidate.balanceSol,
          referenceToken: tokenMint,
          referencePool: tokenItem.poolName,
          score: score + (convergenceCount * 5) // convergence bonus in queue priority
        });

        if (queued) {
          queuedCount++;
          console.log(`[WhaleScout PRO] 📋 SHADOW QUEUE (SMS ${score}/100): ${bestCandidate.label}`);

          const queueMsg = `📋 *SMART MONEY (SMS ${score}/100) MASUK SHADOW QUEUE*

` +
            `Slot penuh. Kandidat konvergensi terbaik disimpan:

` +
            `🏷️ *Label:* ${bestCandidate.label}
` +
            `📝 *Alamat:* \`${feePayerKey}\`
` +
            `🧠 *SMS Score:* *${score}/100* [${tier}] | Conv: *${convergenceCount} wallet*
` +
            `💰 *Saldo:* *${bestCandidate.balanceSol.toFixed(2)} SOL*
` +
            `🪙 *Pool:* *$${symbol}*

` +
            `_💡 Dipromosikan otomatis begitu ada slot kosong!_`;

          await notify(queueMsg);
        }
      }
    }

    if (recruitedCount > 0) {
      refreshWhaleSubscriptions();
      console.log(`[WhaleScout PRO] 🎯 Berhasil merekrut ${recruitedCount} smart money whale (Convergence-First).`);
    }
    if (queuedCount > 0) {
      console.log(`[WhaleScout PRO] 📋 ${queuedCount} kandidat masuk shadow queue.`);
    }
  } catch (err: any) {
    console.error('[WhaleScout PRO] Error during scoutTrendingWhales:', err.message);
  }

  const latestWhales = getAllWhales();
  const latestQueue = getWhaleQueue();

  return {
    recruited: recruitedCount,
    queued: queuedCount,
    isFull: latestWhales.length >= CONFIG.MAX_ACTIVE_WHALES,
    totalWhales: latestWhales.length,
    maxWhales: CONFIG.MAX_ACTIVE_WHALES,
    queueLength: latestQueue.length
  };
}

// ============================================================================
// PILAR 3: Smart Roster Cleanup — Prune Agresif + Auto-Promosi Antrean
// ============================================================================
/**
 * PRO PRUNER: Aggressive underperformer elimination + immediate queue promotion.
 * - Rolling Alpha Decay: Win Rate < 40% over 7-day window → PROBATION
 * - Aggressive Prune: Negative PnL + auto_copy=0 + idle > 48h → ELIMINATED
 * - Dead Wallets: Balance < 0.2 SOL → ELIMINATED
 * - Auto-Substitution: Every freed slot immediately filled from shadow queue
 */
export async function pruneUnderperformingWhales(): Promise<number> {
  console.log('[WhaleScout PRO] 🧹 Menjalankan Smart Roster Cleanup (Prune Agresif + Auto-Promosi)...');
  
  const allWhales = getAllWhales();
  if (allWhales.length <= 3) {
    return 0;
  }

  // ── Stage 1: Rolling Alpha Decay Check ──
  for (const whale of allWhales) {
    if (whale.tier !== 'PROBATION' && whale.auto_copy) {
      try {
        const { getWhaleRollingStats, demoteWhale } = await import('../db/index');
        const rolling = getWhaleRollingStats(whale.label, CONFIG.ROLLING_WINDOW_DAYS);
        if (rolling.rollingTrades >= 3 && rolling.rollingWinRate < 40.0 && rolling.rollingPnlSol <= 0) {
          demoteWhale(whale.id);
          console.log(`[WhaleScout PRO] 📉 ALPHA DECAY: ${whale.label} diturunkan ke PROBATION (7d WR: ${rolling.rollingWinRate.toFixed(1)}%)`);
          const decayMsg = `📉 *ALPHA DECAY: PAUS DIISTIRAHATKAN!*\n\n` +
            `Dompet *${whale.label}* mengalami penurunan performa dalam ${CONFIG.ROLLING_WINDOW_DAYS} hari terakhir:\n` +
            `• Win Rate ${CONFIG.ROLLING_WINDOW_DAYS}d: *${rolling.rollingWinRate.toFixed(1)}%* (${rolling.rollingWins}W / ${rolling.rollingLosses}L)\n` +
            `• PnL ${CONFIG.ROLLING_WINDOW_DAYS}d: *${rolling.rollingPnlSol >= 0 ? '+' : ''}${rolling.rollingPnlSol.toFixed(4)} SOL*\n` +
            `• Status Baru: *PROBATION (SHADOW MODE)* 🔬\n\n` +
            `_Bot membekukan auto-copy untuk melindungi modal Anda._`;
          await notify(decayMsg);
        }
      } catch {}
    }
  }

  let prunedCount = 0;
  const freshWhales = getAllWhales();

  // ── Stage 2: Dead Wallet Elimination (Balance < 0.2 SOL) ──
  for (const whale of freshWhales) {
    if (getAllWhales().length <= 3) break;
    try {
      const lamports = await connection.getBalance(new PublicKey(whale.address));
      const balanceSol = lamports / 1_000_000_000;

      if (balanceSol < 0.2) {
        const removed = removeWhale(whale.id, 'Saldo Habis / Dompet Ditinggalkan (< 0.2 SOL)');
        if (removed) {
          prunedCount++;
          console.log(`[WhaleScout PRO] 🗑️ ELIMINASI DEAD WALLET: ${whale.label} Saldo: ${balanceSol.toFixed(3)} SOL`);
          await notify(
            `🗑️ *PAUS DIELIMINASI: SALDO HABIS (Dead Wallet)*\n\n` +
            `🏷️ *Label:* ${whale.label} [${whale.tier || 'PROBATION'}]\n` +
            `📝 *Alamat:* \`${whale.address}\`\n` +
            `💰 *Sisa Saldo:* *${balanceSol.toFixed(3)} SOL* (Dompet mati)\n\n` +
            `_Auto-Substitution langsung mengisi slot ini dari shadow queue._`
          );
        }
      }
    } catch {}
  }

  // ── Stage 3: Aggressive Prune (PnL < -0.02 SOL + auto_copy=0 + idle > 48h) ──
  const aggressivePruneThresholdHours = CONFIG.WHALE_IDLE_AGGRESSIVE_PRUNE_HOURS || 48;
  for (const whale of getAllWhales()) {
    if (getAllWhales().length <= 3) break;

    const pnlNegative = (whale.total_pnl_sol || 0) < -0.015;
    const isCopyOff = !whale.auto_copy;
    const lastActivity = whale.last_trade_at ? new Date(whale.last_trade_at).getTime() : 0;
    const idleHours = (Date.now() - lastActivity) / (1000 * 60 * 60);
    const isLongIdle = idleHours > aggressivePruneThresholdHours;

    if (pnlNegative && isCopyOff && isLongIdle) {
      const reason = `Prune Agresif: PnL ${whale.total_pnl_sol?.toFixed(4)} SOL negatif + auto_copy=OFF + idle ${idleHours.toFixed(0)}h`;
      const removed = removeWhale(whale.id, reason);
      if (removed) {
        prunedCount++;
        console.log(`[WhaleScout PRO] ✂️ AGGRESSIVE PRUNE: ${whale.label} (${reason})`);
        await notify(
          `✂️ *PAUS DIPRUNE (AGGRESSIVE CLEANUP)*\n\n` +
          `🏷️ *Label:* ${whale.label} [${whale.tier || 'PROBATION'}]\n` +
          `📝 *Alamat:* \`${whale.address}\`\n` +
          `⚠️ *Alasan:* ${reason}\n` +
          `📊 *PnL:* *${whale.total_pnl_sol?.toFixed(4) || 0} SOL* | Trades: ${whale.total_trades_copied || 0}\n\n` +
          `_Bot menjaga roster hanya diisi smart money paling berkualitas._`
        );
      }
    }
  }

  // ── Stage 4: Standard Performance-Based Prune ──
  const badWhales = getWhalesForPruning(
    CONFIG.AUTO_PRUNE_INACTIVE_HOURS,
    CONFIG.MAX_CONSECUTIVE_LOSSES_PRUNE,
    CONFIG.MIN_WINRATE_PCT
  );

  for (const whale of badWhales) {
    if (getAllWhales().length <= 3) break;

    let reason = '';
    const pruneThreshold = CONFIG.MAX_CONSECUTIVE_LOSSES_PRUNE || 4;
    if (whale.consecutive_losses >= pruneThreshold) {
      reason = `Performa Buruk Kronis (${whale.consecutive_losses}x Stop-Loss Berturut-turut)`;
    } else if (whale.total_trades_copied >= 4 && whale.win_rate < CONFIG.MIN_WINRATE_PCT && (whale.total_pnl_sol || 0) <= 0) {
      reason = `Win Rate Rendah (${whale.win_rate.toFixed(1)}% < ${CONFIG.MIN_WINRATE_PCT}% dari ${whale.total_trades_copied} trade, PnL <= 0)`;
    } else {
      reason = `Tidak Aktif (> ${CONFIG.AUTO_PRUNE_INACTIVE_HOURS} jam tanpa transaksi)`;
    }

    const removed = removeWhale(whale.id, reason);
    if (removed) {
      prunedCount++;
      console.log(`[WhaleScout PRO] 🗑️ STANDARD PRUNE: ${whale.label} — ${reason}`);
      await notify(
        `🗑️ *DOMPET PAUS RESMI DIELIMINASI DARI RADAR!*\n\n` +
        `🏷️ *Label:* ${whale.label} [${whale.tier || 'PROBATION'}]\n` +
        `📝 *Alamat:* \`${whale.address}\`\n` +
        `⚠️ *Alasan:* *${reason}*\n` +
        `📊 *Statistik:* ${whale.wins || 0}W / ${whale.losses || 0}L (WR: *${whale.win_rate?.toFixed(1) || 0}%*) | PnL: *${whale.total_pnl_sol >= 0 ? '+' : ''}${whale.total_pnl_sol?.toFixed(4) || 0} SOL*\n\n` +
        `_Bot menjaga standar kualitas radar agar hanya dompet paling menguntungkan yang dipertahankan._`
      );
    }
  }

  if (prunedCount > 0) {
    console.log(`[WhaleScout PRO] ✂️ Total ${prunedCount} dompet dieliminasi.`);
  }

  // ── Stage 5: Immediate Auto-Substitution from Shadow Queue ──
  let substitutedCount = 0;
  const currentCount = getAllWhales().length;
  const availableSlots = CONFIG.MAX_ACTIVE_WHALES - currentCount;

  if (availableSlots > 0) {
    console.log(`[WhaleScout PRO] 🔄 ${availableSlots} slot kosong — Auto-Substitution dari Shadow Queue...`);
    for (let i = 0; i < availableSlots; i++) {
      const promoted = promoteQueueWhaleToActive();
      if (!promoted) break;

      substitutedCount++;
      console.log(`[WhaleScout PRO] 🔄 AUTO-SUBSTITUTION: ${promoted.label} (${promoted.address.slice(0,8)}...) dipromosikan dari Shadow Queue.`);
      await notify(
        `🔄 *AUTO-SUBSTITUTION: SMART MONEY BARU DIPROMOSIKAN!*\n\n` +
        `Slot radar terbuka setelah roster cleanup. Kandidat terbaik shadow queue dipromosikan:\n\n` +
        `🏷️ *Paus Baru:* ${promoted.label} [${promoted.tier}]\n` +
        `📝 *Alamat:* \`${promoted.address}\`\n` +
        `🛡️ *Status Copy:* *OFF (Masa Percobaan Shadow Track)* 🔬\n` +
        `⚡ *WebSocket:* Langsung terhubung ke Helius RPC (<400ms).\n\n` +
        `_Bot menjaga kapasitas alpha radar selalu prima dengan rotasi otomatis!_`
      );
    }
  }

  if (prunedCount > 0 || substitutedCount > 0) {
    refreshWhaleSubscriptions();
  }

  return prunedCount;
}

// ============================================================================
// Background Scout & Pruner Loop
// ============================================================================
let scoutInterval: NodeJS.Timeout | null = null;

export function startWhaleScout() {
  if (scoutInterval) return;
  if (!CONFIG.AUTO_WHALE_DISCOVERY) {
    console.log('[WhaleScout PRO] ℹ️ Auto-Whale Discovery dimatikan di konfigurasi.');
    return;
  }

  const migrationNote = CONFIG.WHALE_MIGRATION_SCAN_ENABLED ? ' + Raydium Migration Scanner aktif' : '';
  console.log(`[WhaleScout PRO] 🚀 Autonomous 5-Pilar Pro Scout & Pruner aktif (Interval: ${CONFIG.WHALE_DISCOVERY_INTERVAL_MIN} menit${migrationNote}).`);

  // Initial check after 15 seconds of startup
  setTimeout(async () => {
    try {
      await pruneUnderperformingWhales();
      const count = getAllWhales().length;
      const queueLen = getWhaleQueue().length;
      if (count < CONFIG.MAX_ACTIVE_WHALES || queueLen < 5) {
        await scoutTrendingWhales(CONFIG.WHALE_SCOUT_BATCH_SIZE || 4);
      }
    } catch {}
  }, 15000);

  // Periodic recurring check
  scoutInterval = setInterval(async () => {
    try {
      await pruneUnderperformingWhales();
      const count = getAllWhales().length;
      const queueLen = getWhaleQueue().length;
      if (count < CONFIG.MAX_ACTIVE_WHALES || queueLen < 10) {
        await scoutTrendingWhales(CONFIG.WHALE_SCOUT_BATCH_SIZE || 4);
      }
    } catch (err: any) {
      console.error('[WhaleScout PRO] Error in recurring scout loop:', err.message);
    }
  }, CONFIG.WHALE_DISCOVERY_INTERVAL_MIN * 60 * 1000);
}

export function stopWhaleScout() {
  if (scoutInterval) {
    clearInterval(scoutInterval);
    scoutInterval = null;
  }
}

import { getTokenMarketData } from './dexscreener';
import { 
  getPendingOutcomeEvents, 
  recordEarlyEntryOutcome, 
  updateEarlyEntryStatusById 
} from '../db/index';
import { OutcomeCheckpoint } from '../types/index';

const CHECKPOINTS_CONFIG: Array<{ checkpoint: OutcomeCheckpoint; minMinutes: number }> = [
  { checkpoint: '30m', minMinutes: 30 },
  { checkpoint: '1h', minMinutes: 60 },
  { checkpoint: '6h', minMinutes: 360 },
  { checkpoint: '24h', minMinutes: 1440 }
];

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/**
 * Iterates through pending early entry events and checks forward performance
 * against defined checkpoints (30m, 1h, 6h, 24h).
 * Uses DexScreener/GeckoTerminal public pricing (ZERO Helius RPC used).
 */
export async function evaluatePendingOutcomes(): Promise<{ evaluated: number; completed: number }> {
  const pending = getPendingOutcomeEvents();
  if (pending.length === 0) return { evaluated: 0, completed: 0 };

  let evaluatedCount = 0;
  let completedCount = 0;
  const now = Date.now();

  // Cache token prices during a single sweep to prevent duplicate DexScreener requests
  const tokenPriceCache = new Map<string, number | null>();

  for (const event of pending) {
    const entryTime = new Date(event.wallet_entry_at).getTime();
    const elapsedMinutes = (now - entryTime) / (60 * 1000);
    const measuredList = event.measured_checkpoints.split(',').map(s => s.trim()).filter(Boolean);

    // Find due checkpoints that haven't been measured yet
    const dueCheckpoints = CHECKPOINTS_CONFIG.filter(
      c => elapsedMinutes >= c.minMinutes && !measuredList.includes(c.checkpoint)
    );

    if (dueCheckpoints.length === 0) {
      // Check if all checkpoints are done or past 24h
      if (elapsedMinutes >= 1440 && measuredList.includes('24h')) {
        updateEarlyEntryStatusById(event.id, 'OUTCOME_COMPLETE');
        completedCount++;
      }
      continue;
    }

    // Fetch current price if not in local cache
    let currentPriceUsd: number | null = null;
    if (tokenPriceCache.has(event.token_mint)) {
      currentPriceUsd = tokenPriceCache.get(event.token_mint) ?? null;
    } else {
      try {
        const market = await getTokenMarketData(event.token_mint);
        currentPriceUsd = market?.priceUsd && market.priceUsd > 0 ? market.priceUsd : null;
        tokenPriceCache.set(event.token_mint, currentPriceUsd);
      } catch (err: any) {
        console.warn(`[OutcomeTracker] Gagal ambil harga untuk ${event.token_mint}:`, err.message);
      }
      await sleep(150); // Friendly rate limiting for DexScreener
    }

    if (!currentPriceUsd || currentPriceUsd <= 0) continue;

    const entryPrice = event.entry_price_usd && event.entry_price_usd > 0
      ? event.entry_price_usd
      : currentPriceUsd;

    const pnlPct = ((currentPriceUsd - entryPrice) / entryPrice) * 100;
    const maxDrawdownPct = Math.min(0, pnlPct);

    for (const due of dueCheckpoints) {
      const recorded = recordEarlyEntryOutcome({
        event_id: event.id,
        checkpoint: due.checkpoint,
        price_usd: currentPriceUsd,
        pnl_pct: pnlPct,
        max_drawdown_pct: maxDrawdownPct,
        measured_at: new Date().toISOString()
      });

      if (recorded) {
        evaluatedCount++;
        measuredList.push(due.checkpoint);
        console.log(
          `[OutcomeTracker] 📊 Event #${event.id} (${event.token_mint.slice(0, 6)}... | Wallet ${event.wallet_address.slice(0, 6)}...): ` +
          `Checkpoint ${due.checkpoint} → PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | Price: $${currentPriceUsd}`
        );
      }
    }

    // If 24h checkpoint measured or elapsed > 24 hours
    if (elapsedMinutes >= 1440 || measuredList.includes('24h')) {
      updateEarlyEntryStatusById(event.id, 'OUTCOME_COMPLETE');
      completedCount++;
    }
  }

  return { evaluated: evaluatedCount, completed: completedCount };
}

let outcomeTrackerInterval: NodeJS.Timeout | null = null;

export function startOutcomeTracker(intervalMinutes: number = 10): void {
  if (outcomeTrackerInterval) return;

  console.log(`[OutcomeTracker] 🎯 Forward Outcome Tracker aktif (Interval: ${intervalMinutes} menit). Checkpoints: 30m, 1h, 6h, 24h.`);

  // First run after 30 seconds
  setTimeout(async () => {
    try {
      await evaluatePendingOutcomes();
    } catch (err: any) {
      console.error('[OutcomeTracker] Error in initial evaluatePendingOutcomes:', err.message);
    }
  }, 30000);

  outcomeTrackerInterval = setInterval(async () => {
    try {
      await evaluatePendingOutcomes();
    } catch (err: any) {
      console.error('[OutcomeTracker] Error in recurring evaluatePendingOutcomes:', err.message);
    }
  }, intervalMinutes * 60 * 1000);
}

export function stopOutcomeTracker(): void {
  if (outcomeTrackerInterval) {
    clearInterval(outcomeTrackerInterval);
    outcomeTrackerInterval = null;
    console.log('[OutcomeTracker] 🛑 Outcome tracker dihentikan.');
  }
}

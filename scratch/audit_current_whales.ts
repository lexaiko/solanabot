import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';
import { getAllWhales, getWhaleRollingStats } from '../src/db/index';
import { isMevBotSuspect } from '../src/services/whaleScout';
import { isCabalSuspect } from '../src/services/cabalDetector';

const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');

async function auditCurrentWhales() {
  console.log('🏛️ =========================================================');
  console.log('🏛️ AUDIT MENYELURUH DOMPET PAUS AKTIF (PRO HEDGE FUND AUDIT)');
  console.log('🏛️ =========================================================\n');

  const whales = getAllWhales();
  console.log(`Ditemukan ${whales.length} dompet paus di database saat ini.\n`);

  const results: any[] = [];

  for (const w of whales) {
    console.log(`🔍 Mengaudit #${w.id}: ${w.label} (\`${w.address}\`)...`);
    let balanceSol = 0;
    let sigCount = 0;
    let mevResult = { isMev: false, reason: 'N/A' };
    let cabalResult = { isCabal: false, matchingWhales: [] as string[] };
    let onChainStatus = 'ACTIVE';

    try {
      const pubkey = new PublicKey(w.address);
      const lamports = await connection.getBalance(pubkey);
      balanceSol = lamports / 1_000_000_000;

      const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 25 });
      sigCount = sigs.length;

      if (sigs.length > 0) {
        mevResult = await isMevBotSuspect(w.address, sigs);
      } else {
        onChainStatus = 'INACTIVE / NO RECENT TXS';
      }

      cabalResult = await isCabalSuspect(w.address, whales.filter(other => other.id !== w.id));
    } catch (err: any) {
      console.warn(`  ⚠️ Gagal ambil data on-chain untuk ${w.address}:`, err.message);
      onChainStatus = `ERROR: ${err.message}`;
    }

    const rolling = getWhaleRollingStats(w.label, 7);

    // Institutional Verdict:
    let verdict = '✅ LAYAK (KEEP)';
    const issues: string[] = [];

    if (balanceSol < CONFIG.MIN_WHALE_BALANCE_SOL) {
      issues.push(`Saldo rendah (${balanceSol.toFixed(2)} SOL < ${CONFIG.MIN_WHALE_BALANCE_SOL} SOL)`);
    }
    if (mevResult.isMev) {
      issues.push(`Terindikasi Bot MEV/HFT (${mevResult.reason})`);
      verdict = '🚨 ELIMINASI (MEV BOT)';
    }
    if (cabalResult.isCabal) {
      issues.push(`Kluster Cabal dengan ${cabalResult.matchingWhales.join(', ')}`);
      verdict = '⚠️ CURIGA CABAL';
    }
    if (w.consecutive_losses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
      issues.push(`${w.consecutive_losses}x Loss Berturut-turut`);
      verdict = '❌ ELIMINASI (UNDERPERFORMER)';
    }
    if (w.total_trades_copied >= 3 && w.win_rate < CONFIG.MIN_WINRATE_PCT) {
      issues.push(`Win Rate Buruk (${w.win_rate.toFixed(1)}%)`);
      verdict = '❌ ELIMINASI (LOW WINRATE)';
    }
    if (issues.length > 0 && verdict === '✅ LAYAK (KEEP)') {
      verdict = '🔬 PROBATION (OBSERVASI)';
    }

    results.push({
      id: w.id,
      label: w.label,
      address: w.address,
      tier: w.tier,
      autoCopy: w.auto_copy ? 'ON' : 'OFF',
      balanceSol: balanceSol.toFixed(2),
      sigCount,
      tradesCopied: w.total_trades_copied,
      winRate: (w.win_rate || 0).toFixed(1) + '%',
      totalPnlSol: w.total_pnl_sol.toFixed(4),
      lossStreak: w.consecutive_losses,
      rolling7dWinRate: rolling.rollingTrades > 0 ? `${rolling.rollingWinRate.toFixed(1)}% (${rolling.rollingTrades} trades)` : '0 trades',
      verdict,
      issues
    });
  }

  console.log('\n📊 HASIL AUDIT LENGKAP:');
  console.log(JSON.stringify(results, null, 2));
}

auditCurrentWhales().catch(console.error);

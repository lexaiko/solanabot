import { DatabaseSync } from 'node:sqlite';
import axios from 'axios';
import { CONFIG } from './src/config.js';

interface ResultRow {
  address: string;
  label: string;
  totalSwaps: number;
  wins: number;
  losses: number;
  winRate: number;
  netSol: number;
  passesWr60: boolean;
  passesWr45: boolean;
  passes10Swaps: boolean;
  passesDualFilter: boolean; // >= 10 swaps AND (WR >= 45% OR Net SOL > 0)
}

async function runAudit() {
  const db = new DatabaseSync('tradingbot.db');
  const apiKey = CONFIG.HELIUS_API_KEYS[0] || CONFIG.HELIUS_API_KEY;

  // Get active whales + early candidates
  const whales = db.prepare('SELECT address, label FROM whales LIMIT 10').all() as any[];
  
  let candidates: any[] = [];
  try {
    candidates = db.prepare('SELECT DISTINCT wallet_address as address, token_symbol FROM early_entry_events LIMIT 10').all() as any[];
  } catch (e) {
    // Table might be empty locally if scanner ran on VPS
  }

  const allWallets: { address: string; label: string }[] = [];
  whales.forEach(w => allWallets.push({ address: w.address, label: w.label || 'Whale' }));
  candidates.forEach(c => allWallets.push({ address: c.address, label: `Candidate (${c.token_symbol || 'token'})` }));

  // Add top known public smart money wallets if needed
  if (allWallets.length < 5) {
    allWallets.push(
      { address: 'BqSg3oNEY2LNDWmr2hniLnPLz9McRbEyKio7zrAk88Vf', label: 'PENGU Whale' },
      { address: 'CCXhcnRi5D3ADbADbRy3JEfDv1TsPRiAuWdyhf7uLKog', label: 'CRIMECAT Whale' },
      { address: 'J2p7Z71qoBmqXWVG9wN87pcQLK6Wna9HjihCKQu1r3Di', label: 'fone Whale' },
      { address: 'C23qsHCZqxtXZ2XKho4N4g55WCWTxdR9zp8EVE5pKnXx', label: 'LOOM Whale' }
    );
  }

  console.log(`\n======================================================`);
  console.log(` AUDITING ${allWallets.length} REAL WALLETS ON HELIUS SWAP API`);
  console.log(`======================================================\n`);

  const results: ResultRow[] = [];

  for (const item of allWallets) {
    try {
      const url = `https://api.helius.xyz/v0/addresses/${item.address}/transactions?api-key=${apiKey}&limit=50&type=SWAP`;
      const res = await axios.get(url, { timeout: 8000 });
      const txs: any[] = res.data || [];

      let wins = 0;
      let losses = 0;
      let totalPnlSol = 0;

      for (const tx of txs) {
        const nativeDiff = tx.nativeTransfers?.reduce((sum: number, t: any) => {
          if (t.toUserAccount === item.address) return sum + t.amount;
          if (t.fromUserAccount === item.address) return sum - t.amount;
          return sum;
        }, 0) ?? 0;

        totalPnlSol += nativeDiff / 1e9;
        if (nativeDiff > 0) wins++;
        else if (nativeDiff < -0.001 * 1e9) losses++;
      }

      const totalSwaps = wins + losses;
      const winRate = totalSwaps > 0 ? (wins / totalSwaps) * 100 : 0;
      const passes10Swaps = totalSwaps >= 10;
      const passesWr60 = passes10Swaps && winRate >= 60.0;
      const passesWr45 = passes10Swaps && winRate >= 45.0;
      const passesDual = passes10Swaps && (winRate >= 45.0 || totalPnlSol > 0);

      results.push({
        address: item.address,
        label: item.label,
        totalSwaps,
        wins,
        losses,
        winRate,
        netSol: totalPnlSol,
        passesWr60,
        passesWr45,
        passes10Swaps,
        passesDualFilter: passesDual
      });

      console.log(`[${item.label.padEnd(28)}] Swaps: ${String(totalSwaps).padStart(2)} | WR: ${winRate.toFixed(1).padStart(5)}% | Net: ${(totalPnlSol >= 0 ? '+' : '') + totalPnlSol.toFixed(2)} SOL | >=10 Swaps: ${passes10Swaps ? '✅' : '❌'} | WR>=60%: ${passesWr60 ? '✅ LOLOS' : '❌ GAGAL'}`);
    } catch (err: any) {
      console.log(`[ERR] ${item.address}: ${err.message}`);
    }
  }

  // Summary statistics
  const totalAudited = results.length;
  const countWith10Swaps = results.filter(r => r.passes10Swaps).length;
  const countPassWr60 = results.filter(r => r.passesWr60).length;
  const countPassWr45 = results.filter(r => r.passesWr45).length;
  const countPassDual = results.filter(r => r.passesDualFilter).length;

  console.log(`\n======================================================`);
  console.log(` STATISTIK HASIL AUDIT DARI ${totalAudited} WALLET REAL:`);
  console.log(`======================================================`);
  console.log(`1. Wallet yang punya >= 10 Swaps               : ${countWith10Swaps} / ${totalAudited} (${((countWith10Swaps/totalAudited)*100).toFixed(0)}%)`);
  console.log(`2. Lolos jika syarat: >= 10 Swaps DAN WR >= 60%: ${countPassWr60} / ${totalAudited} (${((countPassWr60/totalAudited)*100).toFixed(0)}%) <--- LIHAT INI!`);
  console.log(`3. Lolos jika syarat: >= 10 Swaps DAN WR >= 45%: ${countPassWr45} / ${totalAudited} (${((countPassWr45/totalAudited)*100).toFixed(0)}%)`);
  console.log(`4. Lolos Dual (>= 10 Swaps & [WR>=45% OR +SOL]): ${countPassDual} / ${totalAudited} (${((countPassDual/totalAudited)*100).toFixed(0)}%)`);
  console.log(`======================================================\n`);
}

runAudit().catch(console.error);

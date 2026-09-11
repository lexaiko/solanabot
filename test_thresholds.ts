import axios from 'axios';
import { CONFIG } from './src/config';

async function testThresholds() {
  const apiKey = CONFIG.HELIUS_API_KEYS[0] || CONFIG.HELIUS_API_KEY;

  const testWallets = [
    { label: 'Scout: $PENGU Smart Buyer', address: 'BqSg3oNEY2LNDWmr2hniLnPLz9McRbEyKio7zrAk88Vf' },
    { label: 'Paus: $CRIMECAT Early Accumulator', address: 'CCXhcnRi5D3ADbADbRy3JEfDv1TsPRiAuWdyhf7uLKog' },
    { label: 'Scout: $fone Smart Buyer', address: 'J2p7Z71qoBmqXWVG9wN87pcQLK6Wna9HjihCKQu1r3Di' },
    { label: 'Paus: $LOOM VIP Accumulator', address: 'C23qsHCZqxtXZ2XKho4N4g55WCWTxdR9zp8EVE5pKnXx' },
    { label: 'Scout Candidate (VPS Live Scan)', address: '6fWHsypc3B19Za2bKoJJeh4beoHYNHkebVCLcviTA2WU' }
  ];

  for (const w of testWallets) {
    try {
      const url = `https://api.helius.xyz/v0/addresses/${w.address}/transactions?api-key=${apiKey}&limit=50&type=SWAP`;
      const res = await axios.get(url, { timeout: 8000 });
      const txs = res.data || [];

      let wins = 0;
      let losses = 0;
      let totalPnlSol = 0;

      for (const tx of txs) {
        const nativeDiff = tx.nativeTransfers?.reduce((sum: number, t: any) => {
          if (t.toUserAccount === w.address) return sum + t.amount;
          if (t.fromUserAccount === w.address) return sum - t.amount;
          return sum;
        }, 0) ?? 0;

        const pnlSol = nativeDiff / 1e9;
        totalPnlSol += pnlSol;

        if (nativeDiff > 0) wins++;
        else if (nativeDiff < -0.001 * 1e9) losses++;
      }

      const total = wins + losses;
      const wr = total > 0 ? (wins / total) * 100 : 0;
      console.log(`${w.label}: ${wins}W / ${losses}L (${total} swaps) -> WR: ${wr.toFixed(1)}% | Net SOL PnL: ${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(2)} SOL`);
    } catch (err: any) {
      console.log(`[ERR] ${w.label}: ${err.message}`);
    }
  }
}

testThresholds().catch(console.error);

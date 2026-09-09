import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';
import axios from 'axios';

const TARGET_WALLET = 'HtXuYvqtJbuwhD9shZEJo9KbdjJzAmRNpVKTyHdpRPiT';

async function auditMevPnl() {
  const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');
  const pubkey = new PublicKey(TARGET_WALLET);

  console.log(`\n🔍 Auditing PnL for MEV/HFT Bot Wallet: ${TARGET_WALLET}\n`);

  const balanceLamports = await connection.getBalance(pubkey);
  const balanceSol = balanceLamports / 1e9;
  console.log(`💰 Saldo SOL Saat Ini: ${balanceSol.toFixed(4)} SOL`);

  // Fetch recent signatures (up to 50)
  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 50 });
  console.log(`📜 Total Signatures diperiksa: ${sigs.length}`);

  let totalFeesSol = 0;
  let totalSolIn = 0; // SOL received from sales
  let totalSolOut = 0; // SOL spent on buys

  const tokenTrades: {
    [mint: string]: {
      buyTokens: number;
      sellTokens: number;
      buySol: number;
      sellSol: number;
      txCount: number;
    }
  } = {};

  for (const s of sigs) {
    if (s.err) continue;

    try {
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) continue;

      const feeSol = (tx.meta.fee || 0) / 1e9;
      totalFeesSol += feeSol;

      const preSol = (tx.meta.preBalances[0] || 0) / 1e9;
      const postSol = (tx.meta.postBalances[0] || 0) / 1e9;
      const solDiff = postSol - preSol; // includes fee

      const preTokens = (tx.meta.preTokenBalances || []).filter(b => b.owner === TARGET_WALLET);
      const postTokens = (tx.meta.postTokenBalances || []).filter(b => b.owner === TARGET_WALLET);
      const allMints = new Set([...preTokens.map(t => t.mint), ...postTokens.map(t => t.mint)]);

      for (const mint of allMints) {
        if (mint === 'So11111111111111111111111111111111111111112') continue;

        const preAmt = parseFloat(preTokens.find(t => t.mint === mint)?.uiTokenAmount?.uiAmountString || '0');
        const postAmt = parseFloat(postTokens.find(t => t.mint === mint)?.uiTokenAmount?.uiAmountString || '0');
        const tokenDiff = postAmt - preAmt;

        if (Math.abs(tokenDiff) < 0.0001) continue;

        if (!tokenTrades[mint]) {
          tokenTrades[mint] = { buyTokens: 0, sellTokens: 0, buySol: 0, sellSol: 0, txCount: 0 };
        }
        tokenTrades[mint].txCount++;

        if (tokenDiff > 0) {
          // BUY
          tokenTrades[mint].buyTokens += tokenDiff;
          if (solDiff < 0) {
            tokenTrades[mint].buySol += Math.abs(solDiff);
            totalSolOut += Math.abs(solDiff);
          }
        } else if (tokenDiff < 0) {
          // SELL
          tokenTrades[mint].sellTokens += Math.abs(tokenDiff);
          if (solDiff > 0) {
            tokenTrades[mint].sellSol += solDiff;
            totalSolIn += solDiff;
          }
        }
      }
    } catch (e) {}
  }

  console.log(`\n================ RINCIAN PER TOKEN ================`);
  let wins = 0;
  let losses = 0;
  let totalGrossProfitSol = 0;

  for (const [mint, d] of Object.entries(tokenTrades)) {
    const netSol = d.sellSol - d.buySol;
    totalGrossProfitSol += netSol;

    console.log(`\nToken: ${mint}`);
    console.log(`  Tx Count: ${d.txCount}`);
    console.log(`  Modal Beli: ${d.buySol.toFixed(4)} SOL (${d.buyTokens.toFixed(1)} tokens)`);
    console.log(`  Hasil Jual: ${d.sellSol.toFixed(4)} SOL (${d.sellTokens.toFixed(1)} tokens)`);
    console.log(`  Sisa Koin: ${(d.buyTokens - d.sellTokens).toFixed(1)} tokens`);
    console.log(`  Net Kas: ${netSol >= 0 ? '+' : ''}${netSol.toFixed(4)} SOL`);

    if (d.sellSol > 0) {
      if (netSol > 0) {
        wins++;
        console.log(`  Hasil: 🟢 PROFIT (+${netSol.toFixed(4)} SOL)`);
      } else {
        losses++;
        console.log(`  Hasil: 🔴 RUGI (${netSol.toFixed(4)} SOL)`);
      }
    } else {
      console.log(`  Hasil: ⏳ Belum Dijual / Holding`);
    }
  }

  const netAfterFeesSol = totalGrossProfitSol - totalFeesSol;

  console.log(`\n================ REKAP PNL BOT MEV ================`);
  console.log(`Total Token Pernah Ditradingkan: ${Object.keys(tokenTrades).length}`);
  console.log(`Wins: ${wins} | Losses: ${losses}`);
  console.log(`Total Gas & Priority Fee Dibayar: -${totalFeesSol.toFixed(4)} SOL`);
  console.log(`Gross Trade PnL: ${totalGrossProfitSol >= 0 ? '+' : ''}${totalGrossProfitSol.toFixed(4)} SOL`);
  console.log(`True Net PnL (Setelah Fee): ${netAfterFeesSol >= 0 ? '+' : ''}${netAfterFeesSol.toFixed(4)} SOL`);
}

auditMevPnl().catch(console.error);

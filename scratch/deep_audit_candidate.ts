import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';

const TARGET_WALLET = 'GZkqPWJQahSeDPmjgGZgSAPmpP5WLvKL8gqcAhK21dH';

async function deepAudit() {
  const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');
  const pubkey = new PublicKey(TARGET_WALLET);

  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 100 });
  console.log(`Deep auditing ${sigs.length} signatures for ${TARGET_WALLET}...`);

  // Track token positions: { mint: { buySol: number, sellSol: number, buyTokens: number, sellTokens: number, trades: number } }
  const positionMap: {
    [mint: string]: {
      buySol: number;
      sellSol: number;
      buyTokens: number;
      sellTokens: number;
      closedTrades: number;
      wins: number;
      losses: number;
      holdingTokens: number;
    }
  } = {};

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    if (s.err) continue;

    try {
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) continue;

      const preSol = tx.meta.preBalances[0] || 0;
      const postSol = tx.meta.postBalances[0] || 0;
      const solDiff = (postSol - preSol) / 1e9; // negative if spent SOL (bought token), positive if received SOL (sold token)

      const preTokens = (tx.meta.preTokenBalances || []).filter(b => b.owner === TARGET_WALLET);
      const postTokens = (tx.meta.postTokenBalances || []).filter(b => b.owner === TARGET_WALLET);
      const allMints = new Set([...preTokens.map(t => t.mint), ...postTokens.map(t => t.mint)]);

      for (const mint of allMints) {
        // Exclude native wrapped sol or stablecoins if desired, but keep for completeness
        if (mint === 'So11111111111111111111111111111111111111112') continue;

        const preAmt = parseFloat(preTokens.find(t => t.mint === mint)?.uiTokenAmount?.uiAmountString || '0');
        const postAmt = parseFloat(postTokens.find(t => t.mint === mint)?.uiTokenAmount?.uiAmountString || '0');
        const tokenDiff = postAmt - preAmt;

        if (Math.abs(tokenDiff) < 0.0001) continue;

        if (!positionMap[mint]) {
          positionMap[mint] = {
            buySol: 0,
            sellSol: 0,
            buyTokens: 0,
            sellTokens: 0,
            closedTrades: 0,
            wins: 0,
            losses: 0,
            holdingTokens: 0
          };
        }

        if (tokenDiff > 0) {
          // BUY
          positionMap[mint].buyTokens += tokenDiff;
          if (solDiff < 0) {
            positionMap[mint].buySol += Math.abs(solDiff);
          }
        } else if (tokenDiff < 0) {
          // SELL
          positionMap[mint].sellTokens += Math.abs(tokenDiff);
          if (solDiff > 0) {
            positionMap[mint].sellSol += solDiff;
          }
        }
      }
    } catch (e: any) {
      // skip
    }
  }

  console.log('\n================ PER-TOKEN PERFORMANCE ================');
  let totalWins = 0;
  let totalLosses = 0;
  let totalRealizedSolProfit = 0;
  let activeHoldingCount = 0;

  for (const [mint, stats] of Object.entries(positionMap)) {
    const netSol = stats.sellSol - stats.buySol;
    const remainingTokens = stats.buyTokens - stats.sellTokens;
    const isSoldOut = stats.sellTokens > 0 && remainingTokens <= stats.buyTokens * 0.15; // >85% sold

    console.log(`\nToken CA: ${mint}`);
    console.log(`  Beli: ${stats.buyTokens.toFixed(2)} tokens (Total Modal: ${stats.buySol.toFixed(3)} SOL)`);
    console.log(`  Jual: ${stats.sellTokens.toFixed(2)} tokens (Total Hasil: ${stats.sellSol.toFixed(3)} SOL)`);
    console.log(`  Sisa Token: ${remainingTokens.toFixed(2)} tokens`);
    console.log(`  Net Kas Realized: ${netSol >= 0 ? '+' : ''}${netSol.toFixed(4)} SOL`);

    if (stats.sellSol > 0) {
      if (netSol > 0) {
        totalWins++;
        console.log(`  Status: 🟢 WIN (Profit Realized +${netSol.toFixed(3)} SOL)`);
        totalRealizedSolProfit += netSol;
      } else {
        totalLosses++;
        console.log(`  Status: 🔴 LOSS (Net Realized ${netSol.toFixed(3)} SOL)`);
        totalRealizedSolProfit += netSol;
      }
    } else {
      activeHoldingCount++;
      console.log(`  Status: ⏳ HOLDING / ACCUMULATING (Belum Dijual)`);
    }
  }

  const completedTrades = totalWins + totalLosses;
  const winRate = completedTrades > 0 ? (totalWins / completedTrades) * 100 : 0;

  console.log('\n================ FINAL AUDIT SCORE ================');
  console.log(`Total Completed Trades: ${completedTrades}`);
  console.log(`Wins: ${totalWins} 🟢 | Losses: ${totalLosses} 🔴`);
  console.log(`Win Rate: ${winRate.toFixed(1)}%`);
  console.log(`Total Realized Profit: ${totalRealizedSolProfit >= 0 ? '+' : ''}${totalRealizedSolProfit.toFixed(4)} SOL`);
  console.log(`Tokens Still Holding: ${activeHoldingCount} koin`);
}

deepAudit().catch(console.error);

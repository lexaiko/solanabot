import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';
import { getOrganicTrendingTokens, isMevBotSuspect } from '../src/services/whaleScout';
import { getAllWhales, getWhaleByAddress } from '../src/db/index';
import { isCabalSuspect } from '../src/services/cabalDetector';
import axios from 'axios';

const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');

async function testWiderScout() {
  console.log('=== TESTING EXPANDED PRO SCOUT ===');
  // 1. Get organic tokens from GeckoTerminal
  let tokens = await getOrganicTrendingTokens(6);

  // 2. Also fetch top Solana tokens from DexScreener high volume/gainers
  try {
    const res = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', { timeout: 6000 });
    const pairs = res.data?.pairs?.filter((p: any) => 
      p.chainId === 'solana' && 
      (p.volume?.h24 || 0) >= 500000 && 
      (p.liquidity?.usd || 0) >= 30000
    ) || [];

    for (const p of pairs) {
      if (tokens.length >= 10) break;
      const mint = p.baseToken?.address;
      if (mint && !tokens.some(t => t.tokenMint === mint)) {
        tokens.push({
          tokenMint: mint,
          poolName: `${p.baseToken?.symbol || 'SOL'} / ${p.quoteToken?.symbol || 'SOL'}`,
          volumeUsd: p.volume?.h24 || 0
        });
      }
    }
  } catch (err: any) {
    console.warn('Dexscreener fetch error:', err.message);
  }

  console.log(`Analyzing ${tokens.length} high-conviction pools...`);

  let foundWhales: any[] = [];

  for (const t of tokens) {
    console.log(`\nChecking Pool: ${t.poolName} ($${(t.volumeUsd / 1_000_000).toFixed(2)}M Vol) CA: ${t.tokenMint.slice(0, 10)}...`);
    let sigs: any[] = [];
    try {
      sigs = await connection.getSignaturesForAddress(new PublicKey(t.tokenMint), { limit: 35 });
    } catch {
      continue;
    }

    console.log(`  Inspecting ${sigs.length} recent signatures...`);

    for (const sigInfo of sigs) {
      if (sigInfo.err) continue;
      try {
        const tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx || !tx.meta) continue;

        const feePayerKey = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58();
        if (!feePayerKey || feePayerKey.length < 32) continue;
        if (getWhaleByAddress(feePayerKey)) continue;

        const post = tx.meta.postTokenBalances?.find((b: any) => b.owner === feePayerKey && b.mint === t.tokenMint);
        const pre = tx.meta.preTokenBalances?.find((b: any) => b.owner === feePayerKey && b.mint === t.tokenMint);
        const postAmt = parseFloat(post?.uiTokenAmount?.uiAmountString || '0');
        const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmountString || '0');

        if (postAmt > preAmt) {
          const balLamports = await connection.getBalance(new PublicKey(feePayerKey));
          const balanceSol = balLamports / 1_000_000_000;

          const preSol = tx.meta.preBalances[0] || 0;
          const postSol = tx.meta.postBalances[0] || 0;
          const solSpent = (preSol - postSol) / 1_000_000_000;

          if (balanceSol < CONFIG.MIN_WHALE_BALANCE_SOL || solSpent < CONFIG.MIN_WHALE_BUY_SOL) {
            continue;
          }

          const pastSigs = await connection.getSignaturesForAddress(new PublicKey(feePayerKey), { limit: 20 });
          if (pastSigs.length < CONFIG.MIN_WHALE_HISTORY_TXS) continue;

          const mevCheck = await isMevBotSuspect(feePayerKey, pastSigs);
          if (mevCheck.isMev) continue;

          const cabalCheck = await isCabalSuspect(feePayerKey, getAllWhales());
          if (cabalCheck.isCabal) continue;

          console.log(`  🎉 FOUND PRO WHALE! Address: ${feePayerKey} | Bal: ${balanceSol.toFixed(2)} SOL | Spent: ${solSpent.toFixed(2)} SOL | Pool: ${t.poolName}`);
          foundWhales.push({
            address: feePayerKey,
            balanceSol,
            solSpent,
            pool: t.poolName
          });
          break; // Next pool
        }
      } catch {}
    }
  }

  console.log(`\n=== TOTAL PRO WHALES DISCOVERED: ${foundWhales.length} ===`);
  console.log(JSON.stringify(foundWhales, null, 2));
}

testWiderScout().catch(console.error);

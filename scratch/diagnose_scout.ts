import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';
import { getOrganicTrendingTokens, isMevBotSuspect } from '../src/services/whaleScout';
import { getAllWhales, getWhaleByAddress } from '../src/db/index';
import { isCabalSuspect } from '../src/services/cabalDetector';

const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');

async function diagnose() {
  console.log('=== DIAGNOSING SCOUT IN REAL TIME ===');
  const tokens = await getOrganicTrendingTokens(3);
  console.log(`Fetched ${tokens.length} organic tokens.`);

  for (const t of tokens) {
    console.log(`\nChecking Pool: ${t.poolName} ($${(t.volumeUsd / 1_000_000).toFixed(2)}M) CA: ${t.tokenMint}`);
    const sigs = await connection.getSignaturesForAddress(new PublicKey(t.tokenMint), { limit: 15 });
    console.log(`Retrieved ${sigs.length} signatures.`);

    let inspectedTxs = 0;
    for (const sigInfo of sigs.slice(0, 10)) {
      if (sigInfo.err) {
        console.log(`  Sig ${sigInfo.signature.slice(0, 10)} has error: skipped.`);
        continue;
      }
      inspectedTxs++;
      const tx = await connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) {
        console.log(`  Sig ${sigInfo.signature.slice(0, 10)} no parsed tx.`);
        continue;
      }

      const firstAccount = tx.transaction.message.accountKeys[0];
      const feePayerKey = firstAccount?.pubkey ? firstAccount.pubkey.toBase58() : null;
      if (!feePayerKey) {
        console.log(`  No fee payer key.`);
        continue;
      }

      const existing = getWhaleByAddress(feePayerKey);
      if (existing) {
        console.log(`  Wallet ${feePayerKey.slice(0, 8)}: ALREADY IN ACTIVE WHALES.`);
        continue;
      }

      const post = tx.meta.postTokenBalances?.find(b => b.owner === feePayerKey && b.mint === t.tokenMint);
      const pre = tx.meta.preTokenBalances?.find(b => b.owner === feePayerKey && b.mint === t.tokenMint);
      const postAmt = parseFloat(post?.uiTokenAmount?.uiAmountString || '0');
      const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmountString || '0');

      const isBuy = postAmt > preAmt;
      console.log(`  Wallet ${feePayerKey.slice(0, 8)} | Post: ${postAmt}, Pre: ${preAmt} -> IsBuy: ${isBuy}`);

      if (!isBuy) continue;

      // Balance check
      const balLamports = await connection.getBalance(new PublicKey(feePayerKey));
      const balSol = balLamports / 1_000_000_000;
      console.log(`    -> Balance: ${balSol.toFixed(3)} SOL (Req: >= ${CONFIG.MIN_WHALE_BALANCE_SOL})`);

      // Buy size
      const preSol = tx.meta.preBalances[0] || 0;
      const postSol = tx.meta.postBalances[0] || 0;
      const solSpent = (preSol - postSol) / 1_000_000_000;
      console.log(`    -> Sol Spent: ${solSpent.toFixed(3)} SOL (Req: >= ${CONFIG.MIN_WHALE_BUY_SOL})`);

      // History
      const pastSigs = await connection.getSignaturesForAddress(new PublicKey(feePayerKey), { limit: 20 });
      console.log(`    -> Past Sigs: ${pastSigs.length} txs (Req: >= ${CONFIG.MIN_WHALE_HISTORY_TXS})`);

      // MEV check
      const mevCheck = await isMevBotSuspect(feePayerKey, pastSigs);
      console.log(`    -> MEV Check: ${mevCheck.isMev ? 'FAILED (' + mevCheck.reason + ')' : 'PASSED'}`);

      // Cabal check
      const cabalCheck = await isCabalSuspect(feePayerKey, getAllWhales());
      console.log(`    -> Cabal Check: ${cabalCheck.isCabal ? 'FAILED' : 'PASSED'}`);

      if (balSol >= CONFIG.MIN_WHALE_BALANCE_SOL && solSpent >= CONFIG.MIN_WHALE_BUY_SOL && pastSigs.length >= CONFIG.MIN_WHALE_HISTORY_TXS && !mevCheck.isMev && !cabalCheck.isCabal) {
        console.log(`    🎉 WALLET QUALIFIED AS PRO SMART MONEY: ${feePayerKey}`);
        return;
      }
    }
  }
}

diagnose().catch(console.error);

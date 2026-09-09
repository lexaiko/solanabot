import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';

const TARGET_WALLET = 'GZkqPWJQahSeDPmjgGZgSAPmpP5WLvKL8gqcAhK21dH';

async function auditCandidateTrades() {
  const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');
  console.log(`\n🔍 Auditing On-Chain Trade History for: ${TARGET_WALLET}\n`);

  const pubkey = new PublicKey(TARGET_WALLET);
  const balanceLamports = await connection.getBalance(pubkey);
  console.log(`💰 Current SOL Balance: ${(balanceLamports / 1e9).toFixed(3)} SOL`);

  // Fetch signatures
  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 40 });
  console.log(`📜 Total Recent Signatures fetched: ${sigs.length}\n`);

  const trades: Array<{
    sig: string;
    blockTime: number | null | undefined;
    timeStr: string;
    type: string;
    tokenMint?: string;
    tokenSymbol?: string;
    tokenChange?: number;
    solChange?: number;
  }> = [];

  for (let i = 0; i < Math.min(sigs.length, 25); i++) {
    const s = sigs[i];
    try {
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta) continue;

      const blockTime = s.blockTime;
      const timeStr = blockTime ? new Date(blockTime * 1000).toISOString() : 'Unknown';

      // SOL balance change
      const preSol = tx.meta.preBalances[0] || 0;
      const postSol = tx.meta.postBalances[0] || 0;
      const solDiff = (postSol - preSol) / 1e9;

      // Token balance changes for this wallet
      const preTokens = (tx.meta.preTokenBalances || []).filter(b => b.owner === TARGET_WALLET);
      const postTokens = (tx.meta.postTokenBalances || []).filter(b => b.owner === TARGET_WALLET);

      const allMints = new Set([...preTokens.map(t => t.mint), ...postTokens.map(t => t.mint)]);

      for (const mint of allMints) {
        const preObj = preTokens.find(t => t.mint === mint);
        const postObj = postTokens.find(t => t.mint === mint);

        const preAmt = parseFloat(preObj?.uiTokenAmount?.uiAmountString || '0');
        const postAmt = parseFloat(postObj?.uiTokenAmount?.uiAmountString || '0');
        const tokenDiff = postAmt - preAmt;

        if (Math.abs(tokenDiff) > 0.000001) {
          const type = tokenDiff > 0 ? 'BUY' : 'SELL';
          trades.push({
            sig: s.signature.slice(0, 10) + '...',
            blockTime,
            timeStr,
            type,
            tokenMint: mint,
            tokenChange: tokenDiff,
            solChange: solDiff
          });
        }
      }
    } catch (e: any) {
      console.warn(`Error parsing sig ${s.signature.slice(0, 8)}: ${e.message}`);
    }
  }

  console.log(`Found ${trades.length} token trade events:\n`);
  for (const t of trades) {
    console.log(`[${t.timeStr}] ${t.type} | Mint: ${t.tokenMint?.slice(0, 8)}... | Token Δ: ${t.tokenChange?.toFixed(2)} | SOL Δ: ${t.solChange?.toFixed(4)} SOL | Sig: ${t.sig}`);
  }

  // Token token groupings
  const tokenGroups: { [mint: string]: typeof trades } = {};
  for (const t of trades) {
    if (!t.tokenMint) continue;
    if (!tokenGroups[t.tokenMint]) tokenGroups[t.tokenMint] = [];
    tokenGroups[t.tokenMint].push(t);
  }

  console.log(`\n================ SUMMARY PER TOKEN ================`);
  for (const [mint, list] of Object.entries(tokenGroups)) {
    const buys = list.filter(x => x.type === 'BUY');
    const sells = list.filter(x => x.type === 'SELL');
    const netSol = list.reduce((acc, x) => acc + (x.solChange || 0), 0);
    console.log(`Token: ${mint.slice(0, 8)}... (${mint})`);
    console.log(`  Buys: ${buys.length}, Sells: ${sells.length}`);
    console.log(`  Net SOL flow: ${netSol.toFixed(4)} SOL`);
  }
}

auditCandidateTrades().catch(console.error);

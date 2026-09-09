import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';

const TARGET_WALLET = 'HtXuYvqtJbuwhD9shZEJo9KbdjJzAmRNpVKTyHdpRPiT';

async function checkWalletSpacing() {
  const connection = new Connection(CONFIG.SOLANA_RPC_URL, 'confirmed');
  const pubkey = new PublicKey(TARGET_WALLET);

  const sigs = await connection.getSignaturesForAddress(pubkey, { limit: 20 });
  console.log(`Total signatures fetched: ${sigs.length}`);

  const blockTimes = sigs.map(s => s.blockTime).filter(bt => bt !== null && bt !== undefined) as number[];

  let rapidCount = 0;
  console.log(`\nTimeline transaksi ${TARGET_WALLET}:`);
  for (let i = 0; i < blockTimes.length - 1; i++) {
    const tCurrent = new Date(blockTimes[i] * 1000).toISOString().slice(11, 19);
    const tNext = new Date(blockTimes[i + 1] * 1000).toISOString().slice(11, 19);
    const diffSec = Math.abs(blockTimes[i] - blockTimes[i + 1]);
    const isRapid = diffSec < 90;
    if (isRapid) rapidCount++;

    console.log(`Tx #${i + 1} (${tCurrent}) -> Tx #${i + 2} (${tNext}) | Selisih: ${diffSec} detik ${isRapid ? '🚨 (<90s)' : '✅'}`);
  }

  const ratio = (rapidCount / (blockTimes.length - 1)) * 100;
  console.log(`\nHasil: ${rapidCount} dari ${blockTimes.length - 1} interval (${ratio.toFixed(1)}%) berjarak < 90 detik.`);
}

checkWalletSpacing().catch(console.error);

import { Connection } from '@solana/web3.js';

const key2 = '640a669a-db61-4e66-992b-98d1ece65bf9';
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${key2}`;
const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${key2}`;

async function testKey2() {
  console.log('Testing Key 2 with Helius...');
  const conn = new Connection(rpcUrl, { commitment: 'confirmed', wsEndpoint: wsUrl });

  const slot = await conn.getSlot();
  console.log(`✅ Key 2 Connected successfully! Current slot: ${slot}`);

  const sub = conn.onSlotChange((info) => {
    console.log(`⚡ Key 2 WebSocket Live! Slot: ${info.slot}`);
    conn.removeSlotChangeListener(sub);
    process.exit(0);
  });

  setTimeout(() => {
    console.log('Timeout');
    process.exit(0);
  }, 4000);
}

testKey2().catch(console.error);

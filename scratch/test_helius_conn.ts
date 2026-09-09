import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
dotenv.config();

const rpcUrl = process.env.SOLANA_RPC_URL || '';
const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');

async function testHelius() {
  console.log(`Connecting to Helius RPC: ${rpcUrl.slice(0, 45)}...`);
  console.log(`Connecting to Helius WS: ${wsUrl.slice(0, 45)}...`);

  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: wsUrl
  });

  const slot = await connection.getSlot();
  console.log(`✅ Helius RPC HTTP Connected! Current Solana Slot: ${slot}`);

  const version = await connection.getVersion();
  console.log(`✅ Solana Version:`, version);

  console.log('Testing WebSocket connection (waiting for next slot notification)...');
  const subId = connection.onSlotChange((slotInfo) => {
    console.log(`⚡ Helius WebSocket LIVE! Received slot event: ${slotInfo.slot}`);
    connection.removeSlotChangeListener(subId);
    process.exit(0);
  });

  // Timeout safety
  setTimeout(() => {
    console.log('WS test timed out after 5s');
    process.exit(0);
  }, 5000);
}

testHelius().catch(console.error);

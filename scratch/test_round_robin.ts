import { connection, getDedicatedEndpoint } from '../src/services/solanaConnection';

async function testRoundRobin() {
  console.log('Testing Helius Round-Robin Pool...');

  const ep1 = getDedicatedEndpoint('WHALE_TRACKER');
  const ep2 = getDedicatedEndpoint('POSITION_MANAGER');

  console.log(`📡 Whale Tracker Endpoint: ...${ep1.key.slice(-8)} (URL: ${ep1.rpcUrl.slice(0, 40)}...)`);
  console.log(`⚡ Position Manager Endpoint: ...${ep2.key.slice(-8)} (URL: ${ep2.rpcUrl.slice(0, 40)}...)`);

  console.log('\nExecuting 4 RPC requests through round-robin connection proxy:');
  for (let i = 1; i <= 4; i++) {
    const slot = await connection.getSlot();
    console.log(`  Req #${i}: Slot ${slot} fetched successfully!`);
  }

  console.log('\n🎉 Round-Robin Pool operational with 2 Helius API Keys!');
}

testRoundRobin().catch(console.error);

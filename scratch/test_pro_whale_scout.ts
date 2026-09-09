import { 
  getOrganicTrendingTokens, 
  isMevBotSuspect 
} from '../src/services/whaleScout';
import { CONFIG } from '../src/config';

console.log('====================================================');
console.log('🧪 PRO-GRADE WHALE SCOUT & MEV FILTER VERIFICATION');
console.log('====================================================\n');

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passCount++;
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    failCount++;
  }
}

async function runTests() {
  // Test 1: Organic Trending Pools Retrieval (GeckoTerminal)
  console.log('--- 1. Testing Organic High-Volume Pools Retrieval ---');
  const tokens = await getOrganicTrendingTokens(3);
  console.log(`   Found ${tokens.length} organic tokens:`);
  for (const t of tokens) {
    console.log(`   • ${t.poolName} | 24h Vol: $${(t.volumeUsd / 1_000_000).toFixed(2)}M | Mint: ${t.tokenMint.slice(0, 10)}...`);
  }
  assert(tokens.length > 0, 'Successfully fetched organic pools from GeckoTerminal without relying on paid ad boosts');
  assert(tokens.every(t => t.volumeUsd >= 50000), 'All organic pools meet the $50k+ volume floor');
  assert(tokens.every(t => t.tokenMint.length >= 32), 'All token mints are valid Solana addresses');

  // Test 2: MEV Sniper Bot Disqualification (Rapid Sub-Minute Flipping)
  console.log('\n--- 2. Testing MEV Bot Holding Time Disqualification ---');
  const now = Math.floor(Date.now() / 1000);

  // Bot signatures: transactions happening every 10 seconds (ultra-fast MEV bot)
  const mevSignatures = [
    { blockTime: now - 10, err: null },
    { blockTime: now - 25, err: null },
    { blockTime: now - 40, err: null },
    { blockTime: now - 55, err: null },
    { blockTime: now - 70, err: null },
  ];
  const mevResult = await isMevBotSuspect('DummyMevBotWalletAddress1111111111111111111', mevSignatures);
  console.log(`   MEV Check Result: isMev=${mevResult.isMev}, Reason="${mevResult.reason}"`);
  assert(mevResult.isMev === true, 'Rapid sub-minute flipping wallet correctly flagged as MEV bot');

  // Test 3: High Failure Rate Spam Bot Disqualification
  console.log('\n--- 3. Testing Spam / Revert Failure Rate Filter ---');
  const spamSignatures = [
    { blockTime: now - 500, err: { InstructionError: [0, 'Custom'] } },
    { blockTime: now - 1000, err: { InstructionError: [1, 'Custom'] } },
    { blockTime: now - 1500, err: { InstructionError: [2, 'Custom'] } },
    { blockTime: now - 2000, err: { InstructionError: [3, 'Custom'] } },
    { blockTime: now - 2500, err: null }, // 4 out of 5 failed = 80% fail rate
  ];
  const spamResult = await isMevBotSuspect('DummySpamBotWalletAddress111111111111111111', spamSignatures);
  console.log(`   Spam Check Result: isMev=${spamResult.isMev}, Reason="${spamResult.reason}"`);
  assert(spamResult.isMev === true, 'High failure rate spam bot correctly disqualified');

  // Test 4: Genuine Human Smart Money Wallet (Healthy Spacing & Success)
  console.log('\n--- 4. Testing Genuine Smart Money Acceptance ---');
  const humanSignatures = [
    { blockTime: now - 3600, err: null },   // 1h ago
    { blockTime: now - 7200, err: null },   // 2h ago
    { blockTime: now - 18000, err: null },  // 5h ago
    { blockTime: now - 86400, err: null },  // 24h ago
    { blockTime: now - 172800, err: null }, // 48h ago
  ];
  const humanResult = await isMevBotSuspect('GenuineWhaleWalletAddress11111111111111111', humanSignatures);
  console.log(`   Human Check Result: isMev=${humanResult.isMev}, Reason="${humanResult.reason}"`);
  assert(humanResult.isMev === false, 'Patient swing / accumulation wallet passes MEV check');

  // Test 5: Config Parameters Elevation
  console.log('\n--- 5. Testing Pro Config Parameters ---');
  console.log(`   MIN_WHALE_BALANCE_SOL: ${CONFIG.MIN_WHALE_BALANCE_SOL} SOL`);
  console.log(`   MIN_WHALE_HOLDING_SEC: ${CONFIG.MIN_WHALE_HOLDING_SEC}s`);
  console.log(`   VIP_WHALE_BALANCE_SOL: ${CONFIG.VIP_WHALE_BALANCE_SOL} SOL`);
  assert(CONFIG.MIN_WHALE_BALANCE_SOL >= 1.5, 'Minimum whale balance elevated to >= 1.5 SOL');
  assert(CONFIG.MIN_WHALE_HOLDING_SEC >= 90, 'Minimum holding threshold active at >= 90s');

  console.log('\n====================================================');
  console.log(`🏁 TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('====================================================');

  if (failCount > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

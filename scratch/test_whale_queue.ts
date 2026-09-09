import { 
  initDatabase, 
  addToWhaleQueue, 
  getWhaleQueue, 
  getQueueWhaleById, 
  popBestQueueWhale, 
  promoteQueueWhaleToActive, 
  removeFromWhaleQueue, 
  clearWhaleQueue,
  getAllWhales,
  removeWhale,
  getWhaleByAddress
} from '../src/db/index';

console.log('🧪 [TEST] Starting Shadow Queue & Auto-Substitution Engine Verification...');

initDatabase();

// Clean test state
clearWhaleQueue();

const testAddrA = 'TestWhaleQueueAddressAAAA1111111111111111111';
const testAddrB = 'TestWhaleQueueAddressBBBB2222222222222222222';
const testAddrC = 'TestWhaleQueueAddressCCCC3333333333333333333';

// Remove if already in active
removeWhale(testAddrA);
removeWhale(testAddrB);
removeWhale(testAddrC);

console.log('\n--- 1. Testing Insertion into Shadow Queue ---');
const okA = addToWhaleQueue({
  address: testAddrA,
  label: '🔬 Scout: Mid Whale',
  archetype: '🎯 RAYDIUM_HUNTER',
  balanceSol: 5.5,
  referenceToken: 'TokenA1111111',
  referencePool: 'POPCAT / SOL'
});

const okB = addToWhaleQueue({
  address: testAddrB,
  label: '👑 VIP: Mega Whale',
  archetype: '🐋 EARLY_ACCUMULATOR',
  balanceSol: 15.0,
  referenceToken: 'TokenB2222222',
  referencePool: 'WIF / SOL'
});

const okC = addToWhaleQueue({
  address: testAddrC,
  label: '⚡ Smart: Scalper Whale',
  archetype: '⚡ MOMENTUM_SWING',
  balanceSol: 2.1,
  referenceToken: 'TokenC3333333',
  referencePool: 'BONK / SOL'
});

if (!okA || !okB || !okC) {
  throw new Error('Failed to insert candidates into shadow queue');
}
console.log('✅ Successfully enqueued 3 test candidates.');

console.log('\n--- 2. Testing Priority Ordering (Highest Balance/Score First) ---');
const queue = getWhaleQueue();
console.log(`Current Queue Length: ${queue.length}`);
queue.forEach((q, idx) => {
  console.log(`  [#${idx + 1}] ID:${q.id} | ${q.label} | Balance: ${q.balance_sol} SOL | Archetype: ${q.archetype}`);
});

if (queue[0].address !== testAddrB) {
  throw new Error(`Expected highest balance (${testAddrB}) at top of queue, got ${queue[0].address}`);
}
console.log('✅ Queue correctly sorted top candidate by balance/score.');

console.log('\n--- 3. Testing Promotion of Top Candidate to Active Radar ---');
const initialActiveCount = getAllWhales().length;
const promotedWhale = promoteQueueWhaleToActive();

if (!promotedWhale) {
  throw new Error('promoteQueueWhaleToActive returned undefined');
}
console.log(`Promoted Whale: ${promotedWhale.label} [${promotedWhale.tier}] (${promotedWhale.address})`);

if (promotedWhale.address !== testAddrB) {
  throw new Error(`Expected testAddrB to be promoted, got ${promotedWhale.address}`);
}

const activeWhaleInDb = getWhaleByAddress(testAddrB);
if (!activeWhaleInDb) {
  throw new Error('Promoted whale not found in active whales table');
}

const queueAfterPromotion = getWhaleQueue();
if (queueAfterPromotion.some(q => q.address === testAddrB)) {
  throw new Error('Promoted whale still remains in queue table');
}
console.log(`✅ Top candidate successfully transferred from queue to active roster. Remaining in queue: ${queueAfterPromotion.length}`);

console.log('\n--- 4. Testing Specific ID Promotion ---');
const candidateC = queueAfterPromotion.find(q => q.address === testAddrC);
if (!candidateC) throw new Error('Candidate C not found in queue');

const promotedC = promoteQueueWhaleToActive(candidateC.id);
if (!promotedC || promotedC.address !== testAddrC) {
  throw new Error('Failed to promote candidate C by ID');
}
console.log(`✅ Candidate C (#${candidateC.id}) successfully promoted by ID.`);

console.log('\n--- 5. Testing Deletion & Cleanup ---');
const removedA = removeFromWhaleQueue(testAddrA);
console.log(`Removed A from queue: ${removedA}`);

// Clean up test whales from active
removeWhale(testAddrB);
removeWhale(testAddrC);
clearWhaleQueue();

console.log('\n🎉 ALL SHADOW QUEUE & AUTO-SUBSTITUTION TESTS PASSED SUCCESSFULLY!\n');

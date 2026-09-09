import { db } from '../src/db/index';

console.log('=== ALL CURRENT WHALES ===');
const allWhales = db.prepare(`SELECT id, address, label, auto_copy, copy_amount_sol, tier, is_active FROM whales`).all();
console.table(allWhales);

console.log('\n=== DISTINCT WHALE SOURCES IN POSITIONS TABLE ===');
const sources = db.prepare(`SELECT DISTINCT whale_source FROM positions`).all();
console.table(sources);

console.log('\n=== WHALES IN QUEUE (IF ANY) ===');
const queue = db.prepare(`SELECT id, address, label, status FROM whale_queue`).all();
console.table(queue);

process.exit(0);

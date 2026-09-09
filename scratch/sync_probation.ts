import { db, getAllWhales } from '../src/db/index';

// Any whale with 0 wins gets placed into PROBATION
db.prepare("UPDATE whales SET tier = 'PROBATION', auto_copy = 0 WHERE wins = 0").run();

console.log('Final whales status:');
for (const w of getAllWhales()) {
  console.log(`[ID ${w.id}] ${w.label} | Tier: ${w.tier} | AutoCopy: ${w.auto_copy} | Wins: ${w.wins} | Losses: ${w.losses} | WinRate: ${w.win_rate}% | Trades: ${w.total_trades_copied}`);
}

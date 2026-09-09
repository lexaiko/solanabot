import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('tradingbot.db');
const trades = db.prepare('SELECT * FROM trade_history ORDER BY id ASC').all() as any[];
console.log('ALL TRADES IN HISTORY:');
for (const t of trades) {
  console.log(`[#${t.id}] ${t.action} ${t.token_symbol} | Price: $${t.price_usd} | SOL: ${t.total_sol} | PnL%: ${t.pnl_pct}% | PnL$: $${t.pnl_usd} | Reason: ${t.reason} | Time: ${t.timestamp}`);
}

const positions = db.prepare('SELECT * FROM positions ORDER BY id ASC').all() as any[];
console.log('\nALL POSITIONS (OPEN & CLOSED):');
for (const p of positions) {
  console.log(`Pos #${p.id}: ${p.token_symbol} | Status: ${p.status} | HalfClosed: ${p.is_half_closed} | Entry: $${p.entry_price_usd} (${p.entry_sol} SOL) | Current: $${p.current_price_usd} | Peak: $${p.peak_price_usd} | PnL%: ${p.pnl_pct?.toFixed(2)}% | Reason: ${p.close_reason} | Source: ${p.whale_source}`);
}

const wallet = db.prepare('SELECT * FROM paper_wallet').all() as any[];
console.log('\nPAPER WALLET:', wallet);

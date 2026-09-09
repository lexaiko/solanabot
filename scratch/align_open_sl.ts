import { db, getOpenPositions } from '../src/db/index';

// Clamp any open position SL to maximum 13.5%
db.prepare("UPDATE positions SET target_sl_pct = 13.5 WHERE status = 'OPEN' AND target_sl_pct > 13.5").run();

console.log('Open positions aligned:');
for (const p of getOpenPositions()) {
  console.log(`[#${p.id}] ${p.token_symbol} | Entry: $${p.entry_price_usd} | Current: $${p.current_price_usd} | PnL: ${p.pnl_pct.toFixed(2)}% | SL: -${p.target_sl_pct}% | TP: +${p.target_tp_pct}%`);
}

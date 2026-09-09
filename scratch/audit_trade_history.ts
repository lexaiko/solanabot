import { 
  db, 
  getTradingStats, 
  getPortfolioQuantMetrics, 
  getDailyRealizedPnl, 
  getPaperBalance 
} from '../src/db/index';

console.log('=== 1. PAPER BALANCE & OVERALL STATS ===');
console.log('Current Balance (SOL):', getPaperBalance());
console.log('Trading Stats:', getTradingStats());
console.log('Daily Realized PnL:', getDailyRealizedPnl());

console.log('\n=== 2. QUANT METRICS ===');
console.log(JSON.stringify(getPortfolioQuantMetrics(), null, 2));

console.log('\n=== 3. CLOSED POSITIONS BREAKDOWN ===');
const closedPositions = db.prepare(`
  SELECT id, token_symbol, token_address, whale_source, entry_price_usd, current_price_usd, 
         entry_sol, pnl_usd, pnl_pct, close_reason, opened_at, closed_at 
  FROM positions 
  WHERE status = 'CLOSED' 
  ORDER BY id DESC
`).all() as any[];

console.log(`Total closed positions: ${closedPositions.length}`);
console.table(closedPositions.map(p => ({
  id: p.id,
  symbol: p.token_symbol,
  whale: (p.whale_source || 'MANUAL').slice(0, 18),
  entry_sol: Number(p.entry_sol.toFixed(3)),
  pnl_pct: Number(p.pnl_pct.toFixed(2)) + '%',
  reason: p.close_reason,
  duration_m: p.closed_at && p.opened_at ? ((new Date(p.closed_at).getTime() - new Date(p.opened_at).getTime()) / 60000).toFixed(1) : '-'
})));

console.log('\n=== 4. BREAKDOWN BY EXIT REASON ===');
const reasonStats = db.prepare(`
  SELECT close_reason, 
         COUNT(*) as count, 
         SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) as losses,
         AVG(pnl_pct) as avg_pnl_pct,
         SUM(pnl_usd) as total_pnl_usd
  FROM positions
  WHERE status = 'CLOSED'
  GROUP BY close_reason
`).all();
console.table(reasonStats);

console.log('\n=== 5. BREAKDOWN BY WHALE SOURCE ===');
const whaleStats = db.prepare(`
  SELECT whale_source,
         COUNT(*) as count,
         SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) as losses,
         AVG(pnl_pct) as avg_pnl_pct,
         SUM(pnl_usd) as total_pnl_usd
  FROM positions
  WHERE status = 'CLOSED'
  GROUP BY whale_source
`).all();
console.table(whaleStats);

console.log('\n=== 6. TRADE HISTORY REALIZED NET PNL & FEES ===');
const feeStats = db.prepare(`
  SELECT action,
         COUNT(*) as count,
         SUM(fee_sol) as total_fees,
         SUM(pnl_sol) as total_gross_pnl_sol,
         SUM(net_pnl_sol) as total_net_pnl_sol
  FROM trade_history
  GROUP BY action
`).all();
console.table(feeStats);

console.log('\n=== 7. ALL TRADE HISTORY (LAST 25) ===');
const recentTrades = db.prepare(`
  SELECT id, action, token_symbol, total_sol, pnl_sol, pnl_pct, fee_sol, net_pnl_sol, reason, timestamp
  FROM trade_history
  ORDER BY id DESC
  LIMIT 25
`).all() as any[];
console.table(recentTrades.map(t => ({
  id: t.id,
  act: t.action,
  sym: t.token_symbol,
  sol: t.total_sol ? Number(t.total_sol.toFixed(4)) : 0,
  pnl_s: t.pnl_sol ? Number(t.pnl_sol.toFixed(5)) : 0,
  pnl_pct: t.pnl_pct ? Number(t.pnl_pct.toFixed(2)) + '%' : '0%',
  net_s: t.net_pnl_sol ? Number(t.net_pnl_sol.toFixed(5)) : 0,
  reason: t.reason
})));

process.exit(0);

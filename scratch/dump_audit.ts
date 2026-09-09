import { db, getTradingStats, getPortfolioQuantMetrics, getDailyRealizedPnl } from '../src/db/index';
import fs from 'fs';

const quant = getPortfolioQuantMetrics();
const reasons = db.prepare('SELECT close_reason, count(*) as count, avg(pnl_pct) as avg_pnl, sum(pnl_usd) as total_usd FROM positions WHERE status = \'CLOSED\' GROUP BY close_reason').all();
const whales = db.prepare('SELECT whale_source, count(*) as count, sum(case when pnl_pct > 0 then 1 else 0 end) as wins, sum(case when pnl_pct <= 0 then 1 else 0 end) as losses, avg(pnl_pct) as avg_pnl, sum(pnl_usd) as total_usd FROM positions WHERE status = \'CLOSED\' GROUP BY whale_source').all();
const allPositions = db.prepare('SELECT id, token_symbol, whale_source, entry_sol, pnl_pct, pnl_usd, close_reason, opened_at, closed_at FROM positions WHERE status = \'CLOSED\' ORDER BY id ASC').all();
const allTrades = db.prepare('SELECT id, position_id, token_symbol, action, total_sol, pnl_sol, pnl_pct, fee_sol, net_pnl_sol, reason, timestamp FROM trade_history ORDER BY id ASC').all();

const output = {
  stats: getTradingStats(),
  dailyRealized: getDailyRealizedPnl(),
  quant,
  reasons,
  whales,
  allPositions,
  allTrades
};

fs.writeFileSync('./scratch/audit_output.json', JSON.stringify(output, null, 2), 'utf-8');
console.log('Saved to ./scratch/audit_output.json successfully!');
process.exit(0);

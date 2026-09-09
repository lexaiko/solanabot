import { 
  getPaperBalance, 
  getOpenPositions, 
  getTradeHistory, 
  getTradingStats, 
  getAllWhales, 
  getDailyRealizedPnl,
  getPortfolioQuantMetrics
} from '../src/db/index';
import { CONFIG } from '../src/config';

async function runProTraderAudit() {
  console.log('================================================================');
  console.log('🏛️ INSTITUTIONAL PRO TRADER AUDIT: POST-MORTEM & EQUITY ANALYSIS');
  console.log('================================================================\n');

  const currentBalance = getPaperBalance();
  const initialBalance = CONFIG.INITIAL_PAPER_BALANCE_SOL;
  const balanceDiff = currentBalance - initialBalance;
  const balancePct = ((currentBalance - initialBalance) / initialBalance) * 100;

  console.log(`💰 SALDO DAN EQUITY:`);
  console.log(`• Modal Awal: ${initialBalance.toFixed(3)} SOL`);
  console.log(`• Saldo Kas Saat Ini: ${currentBalance.toFixed(3)} SOL (${balanceDiff >= 0 ? '+' : ''}${balanceDiff.toFixed(3)} SOL / ${balancePct.toFixed(2)}%)`);

  // Open Positions
  const openPos = getOpenPositions();
  const totalInvestedInOpenPos = openPos.reduce((sum, p) => sum + p.entry_sol, 0);
  const openFloatingPnlUsd = openPos.reduce((sum, p) => sum + p.pnl_usd, 0);
  console.log(`• Modal Terkunci di Posisi Aktif: ${totalInvestedInOpenPos.toFixed(3)} SOL across ${openPos.length} tokens`);
  console.log(`• Floating PnL Posisi Terbuka: $${openFloatingPnlUsd.toFixed(2)}\n`);

  console.log('--- RINCIAN POSISI AKTIF YANG MASIH BERJALAN ---');
  for (const p of openPos) {
    console.log(`[#${p.id}] ${p.token_symbol} | Modal: ${p.entry_sol} SOL | Entry: $${p.entry_price_usd} | Current: $${p.current_price_usd} | PnL: ${p.pnl_pct.toFixed(2)}% ($${p.pnl_usd.toFixed(2)}) | Source: ${p.whale_source} | Age: ${p.opened_at}`);
  }

  // Closed Trades Analysis
  const stats = getTradingStats();
  const allHistory = getTradeHistory(100);

  console.log(`\n--- STATISTIK TRADE SELESAI ---`);
  console.log(`• Total Trade Selesai: ${stats.totalTrades}`);
  console.log(`• Menang: ${stats.winTrades} | Kalah: ${stats.lossTrades}`);
  console.log(`• Win Rate: ${stats.winRate}%`);
  console.log(`• Total Realized PnL: $${stats.totalPnlUsd}`);

  // Breakdown by Exit Reason
  const reasonMap: { [reason: string]: { count: number; totalPnlSol: number; winCount: number; lossCount: number } } = {};
  const whalePerfMap: { [whale: string]: { trades: number; wins: number; losses: number; netPnlSol: number } } = {};

  let totalSimulatedFeesSol = 0;
  const roundTripFee = CONFIG.ESTIMATED_BUY_FEE_SOL + CONFIG.ESTIMATED_SELL_FEE_SOL;

  for (const t of allHistory) {
    if (t.action !== 'SELL') continue; // Only evaluate closed sell executions
    const reason = t.reason || 'UNKNOWN';
    const reasonKey = reason.split(' ')[0] || reason;
    const pnlSol = t.net_pnl_sol ?? t.pnl_sol ?? 0;

    if (!reasonMap[reasonKey]) {
      reasonMap[reasonKey] = { count: 0, totalPnlSol: 0, winCount: 0, lossCount: 0 };
    }
    reasonMap[reasonKey].count++;
    reasonMap[reasonKey].totalPnlSol += pnlSol;
    if (t.pnl_pct >= 0) reasonMap[reasonKey].winCount++;
    else reasonMap[reasonKey].lossCount++;

    // Extract whale source from reason e.g. "WHALE_DUMP_FOLLOW (🎯 Scout: $Nasduck Smart Buyer) (100%)"
    const matchWhale = t.reason.match(/\(([^)]+)\)/);
    const w = matchWhale ? matchWhale[1] : 'MANUAL';
    if (!whalePerfMap[w]) {
      whalePerfMap[w] = { trades: 0, wins: 0, losses: 0, netPnlSol: 0 };
    }
    whalePerfMap[w].trades++;
    if (t.pnl_pct >= 0) whalePerfMap[w].wins++;
    else whalePerfMap[w].losses++;
    whalePerfMap[w].netPnlSol += pnlSol;

    totalSimulatedFeesSol += roundTripFee;
  }

  console.log(`\n--- ANALISIS PENYEBAB EXIT (KENAPA BISA JUAL/CUT LOSS) ---`);
  for (const [r, d] of Object.entries(reasonMap)) {
    console.log(`• ${r}: ${d.count}x (Wins: ${d.winCount}, Losses: ${d.lossCount}) | Est. Net SOL: ${d.totalPnlSol.toFixed(4)} SOL`);
  }

  console.log(`\n--- KINERJA PER DOMPET PAUS ---`);
  for (const [w, d] of Object.entries(whalePerfMap)) {
    const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : '0';
    console.log(`• [${w}]: ${d.trades} trades | ${d.wins}W / ${d.losses}L (WR: ${wr}%) | Net: ${d.netPnlSol >= 0 ? '+' : ''}${d.netPnlSol.toFixed(4)} SOL`);
  }

  console.log(`\n• Estimasi Total Biaya Jaringan / Priority Fees (Gas Drag): -${totalSimulatedFeesSol.toFixed(4)} SOL`);

  const quant = getPortfolioQuantMetrics();
  console.log(`\n--- QUANT RISK METRICS ---`);
  console.log(`• Profit Factor: ${quant.profitFactor}`);
  console.log(`• Max Drawdown: ${quant.maxDrawdownPct}% (-${quant.maxDrawdownSol.toFixed(4)} SOL)`);
  console.log(`• Sharpe Ratio: ${quant.sharpeRatio}`);
  console.log(`• Trade Expectancy: ${quant.tradeExpectancySol} SOL`);
}

runProTraderAudit().catch(console.error);

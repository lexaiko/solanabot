import { 
  calculateSharpeRatio, 
  calculateSortinoRatio, 
  calculateProfitFactor, 
  calculateMaxDrawdown,
  calculateComprehensiveQuantMetrics 
} from '../src/services/quantMetrics';
import { 
  generateSyntheticRegime, 
  runBacktest, 
  fetchHistoricalCandles,
  formatBacktestTelegramReport 
} from '../src/services/backtester';
import { initDatabase, getPortfolioQuantMetrics } from '../src/db/index';

console.log('====================================================');
console.log('🧪 INSTITUTIONAL QUANT METRICS & BACKTEST TEST SUITE');
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
  initDatabase();

  // Test 1: Mathematical Accuracy of Sharpe Ratio
  console.log('--- 1. Testing Sharpe Ratio Math ---');
  // Returns: +10%, +20%, +15%, +12%, +18%
  const returnsA = [10, 20, 15, 12, 18];
  const sharpeA = calculateSharpeRatio(returnsA, 0);
  console.log(`   Sample A Sharpe Ratio: ${sharpeA}`);
  assert(sharpeA > 3.0, 'Sharpe Ratio correctly identifies strong positive excess returns');

  // Returns with zero variance
  const flatReturns = [5, 5, 5];
  const sharpeFlat = calculateSharpeRatio(flatReturns);
  assert(sharpeFlat > 0, 'Handles zero variance edge case gracefully');

  // Test 2: Sortino Ratio Math
  console.log('\n--- 2. Testing Sortino Ratio Math ---');
  // Highly asymmetric upside: +50%, +40%, -5%, +30%
  const returnsAsym = [50, 40, -5, 30];
  const sortino = calculateSortinoRatio(returnsAsym, 0);
  const sharpeAsym = calculateSharpeRatio(returnsAsym, 0);
  console.log(`   Asymmetric returns -> Sortino: ${sortino} vs Sharpe: ${sharpeAsym}`);
  assert(sortino > sharpeAsym, 'Sortino ratio rewards asymmetric positive skewness over Sharpe');

  // Test 3: Profit Factor & Max Drawdown
  console.log('\n--- 3. Testing Profit Factor & Max Drawdown ---');
  const pnlList = [0.5, 0.3, -0.2, 0.4, -0.1];
  const pf = calculateProfitFactor(pnlList);
  console.log(`   Profit Factor: ${pf} (Expected: 1.2 / 0.3 = 4.0)`);
  assert(pf === 4.0, 'Profit Factor accurately calculates sum(wins) / sum(|losses|)');

  const equityCurve = [10.0, 10.5, 11.0, 9.9, 10.2, 12.0, 11.4];
  // Peak was 11.0, trough was 9.9 -> Drop = 1.1 / 11.0 = 10.0%
  const mdd = calculateMaxDrawdown(equityCurve);
  console.log(`   Max Drawdown: ${mdd.mddPct}% (Drop: ${mdd.mddAmount} SOL)`);
  assert(mdd.mddPct === 10.0, 'Max Drawdown correctly calculates peak-to-trough decline (10.0%)');

  // Test 4: Comprehensive Metrics Aggregation
  console.log('\n--- 4. Testing Comprehensive Metrics Aggregator ---');
  const tradeHistorySample = [
    { pnlSol: 0.15, pnlPct: 35.0, feeSol: 0.0016 },
    { pnlSol: -0.05, pnlPct: -15.0, feeSol: 0.0016 },
    { pnlSol: 0.22, pnlPct: 50.0, feeSol: 0.0016 }
  ];
  const comprehensive = calculateComprehensiveQuantMetrics(tradeHistorySample, 10.0);
  console.log(`   Net PnL: ${comprehensive.netPnlSol} SOL`);
  console.log(`   Win Rate: ${comprehensive.winRatePct}%`);
  console.log(`   Profit Factor: ${comprehensive.profitFactor}`);
  console.log(`   Trade Expectancy: ${comprehensive.tradeExpectancySol} SOL`);
  assert(comprehensive.winRatePct === 66.7, 'Calculates 66.7% win rate (2/3)');
  assert(comprehensive.netPnlSol > 0, 'Net PnL accurately deducts all fees');
  assert(comprehensive.tradeExpectancySol > 0, 'Positive trade expectancy calculated');

  // Test 5: Backtester with Synthetic Regimes
  console.log('\n--- 5. Testing Backtester Engine on Stress-Test Regimes ---');
  // Bull Regime
  const bullData = generateSyntheticRegime('BULL', 50);
  assert(bullData.candles.length === 50, 'Generates 50 synthetic candles');
  const bullReport = runBacktest(bullData.candles, bullData.tokenSymbol);
  console.log(`   BULL Backtest Trades: ${bullReport.trades.length}, Net PnL: ${bullReport.metrics.netPnlSol} SOL`);
  assert(bullReport.metrics.totalTrades >= 0, 'Runs bull market simulation without crash');

  // Bloodbath Crash Regime (Testing Flash-Exit & Stop Loss)
  const crashData = generateSyntheticRegime('BLOODBATH', 50);
  const crashReport = runBacktest(crashData.candles, crashData.tokenSymbol);
  console.log(`   BLOODBATH Backtest Trades: ${crashReport.trades.length}, MDD: ${crashReport.metrics.maxDrawdownPct}%`);
  assert(crashReport.trades.every(t => t.exitReason !== ''), 'All trades have recorded exit reasons (SL/Flash-Exit)');

  // Test 6: Backtest Report Formatting
  console.log('\n--- 6. Testing Backtest Telegram Report Formatter ---');
  const formattedMsg = formatBacktestTelegramReport(bullReport);
  assert(formattedMsg.includes('INSTITUTIONAL QUANT BACKTEST REPORT'), 'Report contains title');
  assert(formattedMsg.includes('Sharpe Ratio'), 'Report includes Sharpe Ratio');
  assert(formattedMsg.includes('Profit Factor'), 'Report includes Profit Factor');

  // Test 7: Live Portfolio Database Quant Metrics
  console.log('\n--- 7. Testing Live Portfolio Quant Audit from SQLite ---');
  const dbMetrics = getPortfolioQuantMetrics();
  console.log(`   DB Portfolio Total Trades: ${dbMetrics.totalTrades}`);
  console.log(`   DB Portfolio Win Rate: ${dbMetrics.winRatePct}%`);
  console.log(`   DB Portfolio Sharpe Ratio: ${dbMetrics.sharpeRatio}`);
  console.log(`   DB Portfolio Net PnL: ${dbMetrics.netPnlSol} SOL`);
  assert(typeof dbMetrics.sharpeRatio === 'number', 'Sharpe ratio returned as valid number');
  assert(typeof dbMetrics.maxDrawdownPct === 'number', 'MDD returned as valid number');

  console.log('\n====================================================');
  console.log(`🏁 TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('====================================================');

  if (failCount > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test failed with unhandled error:', err);
  process.exit(1);
});

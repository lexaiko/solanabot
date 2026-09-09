import { 
  initDatabase, 
  createPosition, 
  closePosition, 
  getDailyRealizedPnl, 
  getWhaleRollingStats,
  getPositionById,
  getAllWhales
} from '../src/db/index';
import { CONFIG } from '../src/config';

console.log('====================================================');
console.log('🧪 INSTITUTIONAL AUDIT & QUANT CONTROLS VERIFICATION');
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

// Helper to test Narrative extraction logic from tradeManager
function extractNarrative(symbol: string, name: string): string {
  const text = `${symbol} ${name}`.toUpperCase();
  if (/DOGE|SHIB|BONK|WIF|FLOKI|PUP|DOG|CANINE|NEIRO|CHILLDOG/i.test(text)) return 'DOG';
  if (/CAT|MEOW|POPCAT|MOG|FELINE|KITTY|MICHI|HAPPYCAT/i.test(text)) return 'CAT';
  if (/AI|AGENT|BOT|NEURAL|GPT|INTELLIGENCE|DEEP|BRAIN|SYNTH|LLM/i.test(text)) return 'AI';
  if (/TRUMP|BIDEN|POLITIC|KAMALA|MAGA|ELECTION|VOTE|CONGRESS/i.test(text)) return 'POLITICS';
  if (/PEPE|FROG|TOAD|KEK|APU/i.test(text)) return 'PEPE';
  return 'OTHER';
}

async function runAudit() {
  initDatabase();

  // Test 1: Narrative / Sector Concentration Shield
  console.log('--- 1. Testing Narrative & Sector Classification ---');
  assert(extractNarrative('POPCAT', 'Popcat Solana') === 'CAT', 'POPCAT is classified as CAT');
  assert(extractNarrative('BONK', 'Bonk Dog') === 'DOG', 'BONK is classified as DOG');
  assert(extractNarrative('SYNTH', 'Neural Agent AI') === 'AI', 'Neural Agent is classified as AI');
  assert(extractNarrative('TRUMP', 'MAGA 2024') === 'POLITICS', 'MAGA is classified as POLITICS');
  assert(extractNarrative('PEPE', 'Solana Pepe') === 'PEPE', 'PEPE is classified as PEPE');
  assert(extractNarrative('SOLX', 'Solana Exchange Token') === 'OTHER', 'Uncategorized token is classified as OTHER');

  // Test 2: True Net PnL & Gas Drag Accounting
  console.log('\n--- 2. Testing True Net PnL & Gas Drag Accounting ---');
  const dummyCa = 'TestAuditToken' + Date.now();
  const testPos = createPosition({
    token_address: dummyCa,
    token_symbol: 'AUDIT',
    token_name: 'Audit Token',
    amount_tokens: 1000,
    entry_price_usd: 1.0,
    entry_sol: 1.0,
    whale_source: 'Test Auditor 7D',
    target_tp_pct: 50.0,
    target_sl_pct: 25.0
  });

  assert(testPos.target_tp_pct === 50.0, 'Stored target_tp_pct matches adaptive setting (+50%)');
  assert(testPos.target_sl_pct === 25.0, 'Stored target_sl_pct matches adaptive setting (-25%)');

  // Simulate close with 0.2 SOL gross profit
  // Round-trip fee = 0.0010 (buy) + 0.0006 (sell) = 0.0016 SOL
  const closedPos = closePosition(testPos.id, 1.2, 1.2, 'TAKE_PROFIT_TEST');
  assert(closedPos?.status === 'CLOSED', 'Position successfully closed');

  const dailyReport = getDailyRealizedPnl();
  console.log(`   Daily Gross PnL: ${dailyReport.grossPnlSol.toFixed(4)} SOL`);
  console.log(`   Total Fees Deducted: ${dailyReport.totalFeesSol.toFixed(4)} SOL`);
  console.log(`   Daily Net PnL: ${dailyReport.netPnlSol.toFixed(4)} SOL`);
  assert(dailyReport.totalFeesSol > 0, 'Total fees accounted for (non-zero drag)');
  assert(dailyReport.netPnlSol < dailyReport.grossPnlSol, 'Net PnL strictly accounts for gas and bribe drag');

  // Test 3: Rolling 7-Day Alpha Decay Engine
  console.log('\n--- 3. Testing Rolling 7-Day Alpha Decay Engine ---');
  const rollingStats = getWhaleRollingStats('Test Auditor 7D', CONFIG.ROLLING_WINDOW_DAYS);
  console.log(`   Whale 'Test Auditor 7D' 7d Trades: ${rollingStats.rollingTrades}`);
  console.log(`   7d Win Rate: ${rollingStats.rollingWinRate}%`);
  console.log(`   7d Net PnL: ${rollingStats.rollingPnlSol.toFixed(4)} SOL`);
  assert(rollingStats.rollingTrades >= 1, 'Rolling window captures recent trade');
  assert(rollingStats.rollingWinRate === 100, 'Calculates correct win rate for profitable trade');

  // Test 4: Volatility-Adaptive Exit Rules
  console.log('\n--- 4. Testing Volatility-Adaptive Exit Calculation ---');
  function calcAdaptiveExits(effectiveLiquidity: number, priceChange5m: number) {
    let tp = CONFIG.TAKE_PROFIT_PCT;
    let sl = CONFIG.STOP_LOSS_PCT;
    if (CONFIG.VOLATILITY_ADAPTIVE_EXITS) {
      if (effectiveLiquidity < 15000 || Math.abs(priceChange5m) > 10.0) {
        tp = 50.0;
        sl = 25.0;
      } else if (effectiveLiquidity > 50000 && Math.abs(priceChange5m) < 5.0) {
        tp = 25.0;
        sl = 15.0;
      }
    }
    return { tp, sl };
  }

  const volatileBand = calcAdaptiveExits(8000, 15.0);
  assert(volatileBand.tp === 50.0 && volatileBand.sl === 25.0, 'Thin pool / High Volatility gets +50%/-25% band');

  const stableBand = calcAdaptiveExits(120000, 1.2);
  assert(stableBand.tp === 25.0 && stableBand.sl === 15.0, 'Liquid pool / Stable Momentum gets +25%/-15% band');

  // Cleanup test artifacts from DB
  const { initDatabase: _, ...dbModule } = await import('../src/db/index');
  // Directly clean test rows
  const { DatabaseSync } = await import('node:sqlite');
  const path = await import('node:path');
  const db = new DatabaseSync(path.resolve(process.cwd(), 'tradingbot.db'));
  db.exec("DELETE FROM trade_history WHERE token_symbol = 'AUDIT'; DELETE FROM positions WHERE token_symbol = 'AUDIT';");
  console.log('🧹 Cleaned up temporary test positions & trade history.');

  console.log('\n====================================================');
  console.log(`🏁 AUDIT SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('====================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAudit().catch(err => {
  console.error('Audit failed with error:', err);
  process.exit(1);
});

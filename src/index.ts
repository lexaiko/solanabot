import { CONFIG } from './config';
import { initDatabase, getPaperBalance } from './db/index';
import { bot } from './bot/telegram';
import { startWhaleTracker, stopWhaleTracker, setWhaleTradeHandler } from './services/tracker';
import { startPositionManager, stopPositionManager, executeBuyToken, executeWhaleSellFollow } from './services/tradeManager';
import { startWhaleScout, stopWhaleScout } from './services/whaleScout';

async function main() {
  console.log('====================================================');
  console.log(' 🚀 SOLANA SMART MONEY & AUTO-SNIPER TRADING BOT   ');
  console.log('====================================================');

  // 1. Initialize SQLite Database
  initDatabase();
  console.log(`[DB] Database initialized successfully. Paper Balance: ${getPaperBalance().toFixed(3)} SOL`);

  // 2. Connect Whale Tracker to Institutional Auto-Trade Manager (Buy & Sell Sync)
  setWhaleTradeHandler(async (whale, tokenMint, action, solAmount, txSignature, tokenAmount) => {
    const { getWhaleByAddress } = await import('./db/index');
    const currentWhale = getWhaleByAddress(whale.address) || whale;

    if (action === 'BUY') {
      console.log(`[AutoTrade] 🐋 Whale Buy Event: [${currentWhale.tier || 'VERIFIED'}] ${currentWhale.label} bought token ${tokenMint} (${solAmount} SOL)`);

      if (currentWhale.tier === 'PROBATION' || !currentWhale.auto_copy) {
        console.log(`[AutoTrade] 🔬 Whale ${currentWhale.label} berstatus [PROBATION] (Shadow Mode). Mencatat token observasi ${tokenMint} tanpa risiko modal.`);
        try {
          const { getTokenMarketData } = await import('./services/dexscreener');
          const { addShadowWatch } = await import('./db/index');
          const market = await getTokenMarketData(tokenMint);
          if (market && market.priceUsd > 0) {
            addShadowWatch(currentWhale.address, currentWhale.label, tokenMint, market.priceUsd);
          }
        } catch {}
        return;
      }

      let whaleEntryPriceUsd: number | undefined = undefined;
      if (tokenAmount && tokenAmount > 0 && solAmount && solAmount > 0) {
        try {
          const { getSolPriceUsd } = await import('./services/dexscreener');
          const solPrice = await getSolPriceUsd();
          whaleEntryPriceUsd = (solAmount * solPrice) / tokenAmount;
        } catch {}
      }

      // Delegate risk evaluation and lazy Kelly sizing to executeBuyToken (only calculated if all safety & volume filters pass)
      await executeBuyToken(tokenMint, 0, 'COPY_TRADE', currentWhale, whaleEntryPriceUsd, undefined, solAmount);
    } else if (action === 'SELL') {
      console.log(`[AutoTrade] 🚨 Whale Sell Event: [${currentWhale.tier || 'VERIFIED'}] ${currentWhale.label} dumped token ${tokenMint} (${tokenAmount || 0} tokens)`);

      // Check if this whale was in probation and had a shadow watch on this token
      try {
        const { getActiveShadowWatch, closeShadowWatch, closeAllShadowWatchesForWhale, promoteWhale, recordWhaleTrade } = await import('./db/index');
        // Only evaluate and promote if the whale is currently in PROBATION
        if (currentWhale.tier === 'PROBATION') {
          const shadow = getActiveShadowWatch(currentWhale.address, tokenMint);
          if (shadow) {
            const { getTokenMarketData } = await import('./services/dexscreener');
            const market = await getTokenMarketData(tokenMint);
            if (market && market.priceUsd > 0) {
              const pnlPct = ((market.priceUsd - shadow.entry_price_usd) / shadow.entry_price_usd) * 100;
              closeAllShadowWatchesForWhale(currentWhale.address);
              console.log(`[WhaleScout] 🔬 Shadow Trade Evaluated for ${currentWhale.label}: Token ${market.symbol} PnL: ${pnlPct.toFixed(2)}%`);

              if (pnlPct >= 2.0) {
                promoteWhale(currentWhale.address);
                currentWhale.tier = 'VERIFIED';
                currentWhale.auto_copy = 1;
                console.log(`[WhaleScout] 🎖️ PROMOSI: Whale ${currentWhale.label} lolos audisi shadow mode (+${pnlPct.toFixed(1)}% profit)! Status -> VERIFIED`);
                const promoMsg = `🎓 *KANDIDAT SMART MONEY LOLOS AUDISI SHADOW MODE!*\n\n` +
                  `Dompet *${currentWhale.label}* (\`${currentWhale.address.slice(0, 6)}...${currentWhale.address.slice(-4)}\`) berhasil membuktikan profitabilitas di pasar on-chain!\n` +
                  `• Token Uji Coba: *${market.symbol}*\n` +
                  `• Hasil Trade: *+${pnlPct.toFixed(1)}% PROFIT* 🟢\n` +
                  `• Status Baru: *VERIFIED (AUTO-COPY AKTIF)* 🚀\n\n` +
                  `_Mulai sekarang, bot akan otomatis menyalin setiap order beli dari paus ini._`;
                const { bot } = await import('./bot/telegram');
                if (CONFIG.TELEGRAM_ADMIN_ID) {
                  bot.telegram.sendMessage(CONFIG.TELEGRAM_ADMIN_ID, promoMsg, { parse_mode: 'Markdown' }).catch(() => {});
                }
              } else if (pnlPct < -10) {
                recordWhaleTrade(currentWhale.address, -0.01, false);
              }
            }
          }
        }
      } catch {}

      await executeWhaleSellFollow(currentWhale, tokenMint, tokenAmount);
    }
  });

  // 3. Start Background Loops
  startPositionManager();
  startWhaleTracker();
  startWhaleScout();

  // 4. Start Telegram Bot
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    console.warn('\n⚠️ [Telegram] PERINGATAN: TELEGRAM_BOT_TOKEN belum diatur di file .env.');
    console.warn('👉 Buat bot baru di https://t.me/BotFather, salin tokennya, lalu masukkan ke file .env.\n');
  } else {
    try {
      const me = await bot.telegram.getMe();
      console.log(`[Telegram] 🤖 Bot online: @${me.username} (${me.first_name})`);
      
      // Start polling non-blocking
      bot.launch({ dropPendingUpdates: true }).catch((err) => {
        console.error('[Telegram] Polling error:', err.message);
      });
      console.log(`[Telegram] 🚀 Polling aktif. Bot siap menerima pesan di Telegram!`);
    } catch (err: any) {
      console.error('[Telegram] ❌ Gagal menghubungkan bot Telegram:', err.message);
      console.warn('Pastikan TELEGRAM_BOT_TOKEN di .env sudah valid.');
    }
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[System] Shutting down cleanly...');
    stopPositionManager();
    stopWhaleTracker();
    stopWhaleScout();
    try { bot.stop(); } catch {}
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Fatal Error]:', err);
  process.exit(1);
});

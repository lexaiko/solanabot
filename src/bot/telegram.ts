import { Telegraf, Markup } from 'telegraf';
import { CONFIG } from '../config';
import {
  getPaperBalance,
  resetPaperBalance,
  getAllWhales,
  addWhale,
  removeWhale,
  getOpenPositions,
  getTradeHistory,
  getTradingStats,
  promoteWhale,
  demoteWhale,
  getDailyRealizedPnl,
  isCircuitBreakerActive,
  resetCircuitBreaker,
  getDailyStopLossCount,
  getWhaleRollingStats,
  getPortfolioQuantMetrics,
  getWhaleQueue,
  getQueueWhaleById,
  removeFromWhaleQueue,
  clearWhaleQueue,
  popBestQueueWhale,
  promoteQueueWhaleToActive,
  blacklistWhale,
  unblacklistWhale,
  getBlacklistedWhales,
  addWatcher,
  removeWatcher,
  isWatcher,
  getWatchers
} from '../db/index';
import { getSolPriceUsd, getTokenMarketData } from '../services/dexscreener';
import { checkTokenSafety } from '../services/antirug';
import { executeBuyToken, executeSellToken, setTelegramNotifier } from '../services/tradeManager';
import { scoutTrendingWhales, pruneUnderperformingWhales, setScoutNotifier } from '../services/whaleScout';
import { refreshWhaleSubscriptions } from '../services/tracker';
import { auditAllWhalesForClusters } from '../services/cabalDetector';
import {
  fetchHistoricalCandles,
  generateSyntheticRegime,
  runBacktest,
  formatBacktestTelegramReport
} from '../services/backtester';

export const bot = new Telegraf(CONFIG.TELEGRAM_BOT_TOKEN);

/**
 * Bulletproof Markdown sender: Falls back to clean text if markdown entities are invalid.
 * Guarantees the user always receives a response and never gets stuck!
 */
export async function safeReplyWithMarkdown(ctx: any, text: string, extra?: any) {
  try {
    return await ctx.replyWithMarkdown(text, extra);
  } catch (err: any) {
    console.warn('[Telegram] Markdown formatting failed, falling back to clean text:', err.message);
    const cleanText = text.replace(/[*_`\[\]]/g, '');
    try {
      return await ctx.reply(cleanText, extra);
    } catch (fallbackErr: any) {
      console.error('[Telegram] Failed to send fallback message:', fallbackErr.message);
    }
  }
}

// Register Telegram notifiers (Admin + Active Watchers Broadcast)
const sendAdminAlert = async (msg: string, extra?: any) => {
  if (CONFIG.TELEGRAM_ADMIN_ID) {
    try {
      await bot.telegram.sendMessage(CONFIG.TELEGRAM_ADMIN_ID, msg, {
        parse_mode: 'Markdown',
        ...extra
      });
    } catch (err: any) {
      console.warn('[Telegram] Gagal kirim Markdown ke admin, fallback plain text:', err.message);
      try {
        const cleanText = msg.replace(/[*_`\[\]]/g, '');
        await bot.telegram.sendMessage(CONFIG.TELEGRAM_ADMIN_ID, cleanText, extra);
      } catch (fallbackErr: any) {
        console.error('[Telegram] Gagal kirim pesan fallback ke admin:', fallbackErr.message);
      }
    }
  }

  // Broadcast to all active Watchers
  try {
    const watchers = getWatchers();
    for (const w of watchers) {
      if (w.user_id !== CONFIG.TELEGRAM_ADMIN_ID) {
        bot.telegram.sendMessage(w.user_id, msg, {
          parse_mode: 'Markdown',
          ...extra
        }).catch(async (err: any) => {
          if (err?.response?.error_code === 403) {
            removeWatcher(w.user_id);
          } else {
            try {
              const cleanText = msg.replace(/[*_`\[\]]/g, '');
              await bot.telegram.sendMessage(w.user_id, cleanText, extra);
            } catch {}
          }
        });
      }
    }
  } catch {}
};

setTelegramNotifier(sendAdminAlert);
setScoutNotifier(sendAdminAlert);

// Executive/Admin commands that modify state or settings
const ADMIN_COMMANDS = new Set([
  'buy', 'sell', 'settings', 'prune', 'addwhale', 'delwhale',
  'promote', 'demote', 'blacklist', 'unblacklist', 'resetcb',
  'popqueue', 'promotequeue', 'delqueue'
]);

// Middleware: Role-Based Access Control (Admin vs Watcher)
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  const isAdmin = CONFIG.TELEGRAM_ADMIN_ID && userId === CONFIG.TELEGRAM_ADMIN_ID;

  // If text command
  const text = (ctx.message as any)?.text?.trim();
  if (text && text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]+/)[0].toLowerCase();
    if (ADMIN_COMMANDS.has(cmd) && !isAdmin) {
      return ctx.replyWithMarkdown('⛔ *Akses Ditolak*\nPerintah ini hanya dapat diakses oleh Administrator bot.');
    }
  }

  // If callback query is triggered, check admin-only actions
  const cbData = (ctx.callbackQuery as any)?.data;
  if (cbData) {
    const adminActions = [
      'trigger_prune', 'trigger_buy', 'trigger_sell', 'menu_settings',
      'trigger_delwhale', 'trigger_promote', 'trigger_demote', 'reset_paper_balance',
      'trigger_scout', 'promote_queue_top'
    ];
    if (adminActions.some(a => cbData.startsWith(a)) && !isAdmin) {
      return ctx.answerCbQuery('⛔ Akses Ditolak: Hanya Administrator', { show_alert: true });
    }
  }

  return next();
});

// 1. COMMAND: /start & /status
bot.command(['start', 'status'], async (ctx) => {
  const userId = ctx.from?.id;
  const isAdmin = CONFIG.TELEGRAM_ADMIN_ID && userId === CONFIG.TELEGRAM_ADMIN_ID;

  // Non-Admin Welcome Screen (Watcher Mode)
  if (!isAdmin) {
    const subscribed = isWatcher(userId || 0);
    const text = `👋 *Halo, ${ctx.from?.first_name || 'Trader'}!*\n\n` +
      `Selamat datang di *Solana Smart Money & Copy-Trading Bot*!\n` +
      `Kamu saat ini berada dalam mode *Tamu (Watcher / Read-Only)*.\n\n` +
      `Status Notifikasi: ${subscribed ? '🔔 *AKTIF (Menerima Alert Sinyal)*' : '🔕 *NON-AKTIF*'}\n\n` +
      `💡 *Ingin mendapat notifikasi otomatis setiap ada paus borong/jual token?*\n` +
      `Ketik \`/watch\` atau klik tombol di bawah untuk mengaktifkan notifikasi sinyal.\n\n` +
      `📋 *Menu yang bisa kamu akses:*\n` +
      `• \`/positions\` - Lihat koin yang sedang dipegang bot\n` +
      `• \`/whales\` - Radar 15 dompet paus smart money\n` +
      `• \`/report\` atau \`/pnl\` - Jurnal performa profit harian\n` +
      `• \`/quant\` - Audit metrik kuantitatif (Sharpe, Winrate)\n` +
      `• \`/watch\` - Langganan notifikasi transaksi paus\n` +
      `• \`/unwatch\` - Berhenti langganan notifikasi\n\n` +
      `🛡️ *Audit Koin Instan:* Kirimkan Contract Address (CA) token Solana apapun ke sini untuk cek Anti-Rug & Honeypot secara gratis!`;

    return ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
      [
        subscribed 
          ? Markup.button.callback('🔕 Berhenti Notifikasi (/unwatch)', 'action_unwatch')
          : Markup.button.callback('🔔 Aktifkan Alert Sinyal (/watch)', 'action_watch')
      ],
      [
        Markup.button.callback('💼 Posisi Aktif', 'menu_positions'),
        Markup.button.callback('🐋 Radar Paus', 'menu_whales')
      ],
      [
        Markup.button.callback('📊 Laporan 24j', 'menu_report'),
        Markup.button.callback('📐 Metrik Quant', 'menu_quant')
      ]
    ]));
  }

  // Admin Master Dashboard
  const balanceSol = getPaperBalance();
  const solPrice = await getSolPriceUsd();
  const stats = getTradingStats();
  const whales = getAllWhales();
  const activeWhales = whales.filter(w => w.is_active);
  const cb = isCircuitBreakerActive();

  const cbStatusText = cb.active
    ? `🛑 *CIRCUIT BREAKER: AKTIF* (Cooldown: ${Math.ceil((cb.untilMs - Date.now()) / 60000)}m)`
    : `🛡️ *Proteksi Pasar:* Normal (0/${CONFIG.CIRCUIT_BREAKER_MAX_DAILY_LOSSES} Max SL)`;

  const text = `🤖 *SOLANA AUTONOMOUS QUANT ENGINE*\n\n` +
    `⚡ *Status Engine:* Online & WebSocket Feed Realtime (<400ms)\n` +
    `🧪 *Mode Trading:* ${CONFIG.PAPER_TRADING ? '*PAPER TRADING (Simulasi $0 Risiko)*' : '*LIVE TRADING (Real SOL)*'}\n` +
    `${cbStatusText}\n\n` +
    `💼 *Saldo Virtual:* *${balanceSol.toFixed(3)} SOL* (~$${(balanceSol * solPrice).toFixed(2)})\n` +
    `🐋 *Dompet Paus Terhubung:* *${activeWhales.length}* dompet (VIP, Verified, Shadow)\n` +
    `📈 *Posisi Terbuka:* *${stats.openPositionsCount}/${CONFIG.MAX_OPEN_POSITIONS}* token\n` +
    `🏆 *Performa Portofolio:* ${stats.winTrades} Win / ${stats.lossTrades} Loss (Winrate: *${stats.winRate}%*)\n` +
    `💵 *Total Realized PnL:* *$${stats.totalPnlUsd}*\n\n` +
    `💎 *Fitur Institusional Quant (God-Tier Engine):*\n` +
    `• *In-Memory AMM Engine:* Zero-HTTP On-Chain Curve Math (<1ms)\n` +
    `• *Kelly Sizing:* Fractional Kelly Criterion (${CONFIG.KELLY_FRACTION * 100}% Kelly)\n` +
    `• *Flash-Exit Rug Buster:* Auto-dump jika likuiditas ditarik >${CONFIG.FLASH_EXIT_DROP_PCT}%\n` +
    `• *Jito MEV Shield:* ${CONFIG.JITO_MEV_ENABLED ? '✅ Kebal Sandwich Attack (Private Mempool)' : '❌ Nonaktif'}\n` +
    `• *Cabal Sybil Shield:* ${CONFIG.CABAL_SHIELD_ENABLED ? '✅ Deteksi Komplotan Funder Dev' : '❌ Nonaktif'}\n` +
    `• *Whale Copy-Sell Sync:* Dump bersama paus dalam detik yang sama!\n` +
    `• *Anti-Chase Guard:* Tolak beli jika harga melambung >+${CONFIG.MAX_PRICE_DRIFT_PCT}% dari paus.\n` +
    `• *Circuit Breaker:* Bekukan order 4 jam jika kena 3x SL beruntun.\n` +
    `• *Institutional Quant:* Sharpe Ratio, Sortino Ratio, Profit Factor & Historical Backtest Engine.\n\n` +
    `💡 *Tips:* _Ketik /report untuk jurnal 24j, /quant untuk audit rasio Sharpe, atau /backtest untuk replay candle historis!_`;

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Laporan 24j', 'menu_report'),
      Markup.button.callback('📐 Metrik Quant', 'menu_quant'),
      Markup.button.callback('🔬 Backtester', 'menu_backtest')
    ],
    [
      Markup.button.callback('💼 Posisi Aktif', 'menu_positions'),
      Markup.button.callback('🐋 Radar Paus', 'menu_whales')
    ],
    [
      Markup.button.callback('🔍 Pindai Paus', 'trigger_scout'),
      Markup.button.callback('🧹 Evaluasi Paus', 'trigger_prune'),
      Markup.button.callback('⚙️ Settings', 'menu_settings')
    ],
    [
      Markup.button.callback('🔄 Reset Saldo Dummy ke 10 SOL', 'reset_paper_balance')
    ]
  ]));
});

// COMMAND: /help
bot.command('help', async (ctx) => {
  const text = `📖 *DAFTAR LENGKAP PERINTAH TELEGRAM BOT*\n\n` +
    `🤖 *Status & Portofolio:*\n` +
    `• \`/start\` atau \`/status\` - Dashboard utama sistem & status WebSocket\n` +
    `• \`/positions\` - Lihat posisi trade yang sedang aktif dibuka\n` +
    `• \`/report\` atau \`/pnl\` - Jurnal performa trading 24 jam (True Net Accounting)\n` +
    `• \`/quant\` - Audit metrik kuantitatif (Sharpe, Sortino, Profit Factor, MDD)\n` +
    `• \`/backtest\` - Backtester algoritma replay candle historis & skenario stres\n` +
    `• \`/settings\` - Parameter hedge fund, Kelly sizing, slippage & risk controls\n\n` +
    `🐋 *Manajemen Radar Smart Money:*\n` +
    `• \`/whales\` - Radar dompet paus aktif yang sedang dipantau\n` +
    `• \`/scout\` - Pindai pasar untuk merekrut paus baru (lolos audit on-chain)\n` +
    `• \`/queue\` - Lihat Shadow Queue (Bangku Cadangan smart money)\n` +
    `• \`/popqueue\` - Promosikan top kandidat dari queue ke radar aktif\n` +
    `• \`/promotequeue <id>\` - Promosikan kandidat tertentu dari queue ke radar aktif\n` +
    `• \`/delqueue <id>\` - Hapus kandidat dari Shadow Queue\n` +
    `• \`/prune\` - Evaluasi & eliminasi paus berkinerja buruk (Auto-substitusi)\n` +
    `• \`/promote <id>\` - Promosikan paus aktif ke status VERIFIED (Auto-Copy On)\n` +
    `• \`/demote <id>\` - Turunkan paus aktif ke status PROBATION (Observasi)\n` +
    `• \`/delwhale <id>\` - Hapus paus aktif dari radar (Auto-substitusi)\n` +
    `• \`/addwhale <addr> <label>\` - Tambah dompet paus manual ke radar\n\n` +
    `🛡️ *Keamanan & Proteksi:*\n` +
    `• \`/cabal\` - Audit kluster sindikat cabal / funder dev\n` +
    `• \`/blacklist\` - Lihat atau kelola daftar dompet yang diblokir permanen\n` +
    `• \`/unblacklist <addr>\` - Buka blokir dompet dari blacklist\n` +
    `• \`/resetcb\` - Reset Circuit Breaker jika terpicu cooldown\n` +
    `• Paste Alamat Kontrak (CA) apapun untuk audit instan Anti-Rug & Quick Snipe!`;

  await ctx.replyWithMarkdown(text);
});

// 2. DYNAMIC CONTRACT ADDRESS (CA) LISTENER
// When user pastes any Solana token address (32-44 Base58 characters)
bot.hears(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, async (ctx) => {
  const tokenMint = ctx.message.text.trim();
  await handleTokenAuditAndSnipe(ctx, tokenMint);
});

async function handleTokenAuditAndSnipe(ctx: any, tokenMint: string) {
  await ctx.replyWithMarkdown(`🔍 *Menganalisis Token:* \`${tokenMint}\`...`);

  const [market, safety] = await Promise.all([
    getTokenMarketData(tokenMint),
    checkTokenSafety(tokenMint)
  ]);

  if (!market) {
    return ctx.replyWithMarkdown(`❌ Token \`${tokenMint}\` tidak ditemukan atau belum memiliki likuiditas aktif di DEX Solana.`);
  }

  let text = `🪙 *${market.symbol}* - ${market.name}\n` +
    `📝 \`${tokenMint}\`\n\n` +
    `📊 *Data Pasar:*\n` +
    `• Harga: *$${market.priceUsd < 0.01 ? market.priceUsd.toExponential(4) : market.priceUsd.toFixed(6)}*\n` +
    `• Market Cap: *$${formatNumber(market.marketCap)}*\n` +
    `• Likuiditas: *$${formatNumber(market.liquidityUsd)}*\n` +
    `• Perubahan 24 Jam: *${market.priceChange24h >= 0 ? '+' : ''}${market.priceChange24h.toFixed(2)}%*\n\n` +
    `🛡️ *Audit Keamanan Anti-Rug:*\n` +
    `• Score: *${safety.score}/100* (${safety.isSafe ? '✅ AMAN' : '⚠️ RISIKO TINGGI'})\n` +
    `• Mint Authority: ${safety.mintAuthorityRevoked ? '✅ Revoked' : '❌ AKTIF (Bisa cetak koin)'}\n` +
    `• Freeze Authority: ${safety.freezeAuthorityRevoked ? '✅ Revoked' : '❌ AKTIF (Honeypot)'}\n` +
    `• Likuiditas: ${safety.lpBurnedOrLocked ? '✅ Burned / Locked' : '❌ Unlocked (Bisa ditarik dev)'}\n` +
    `• Top 10 Holders: *${safety.top10HoldersPct.toFixed(1)}%*\n`;

  if (safety.risks.length > 0) {
    text += `\n⚠️ *Peringatan:*\n` + safety.risks.map(r => `• ${r}`).join('\n') + `\n`;
  }

  text += `\n_Pilih aksi di bawah ini untuk eksekusi order:_`;

  const buttons = [
    [
      Markup.button.callback('⚡ Beli 0.05 SOL', `buy_quick_${tokenMint}_0.05`),
      Markup.button.callback('⚡ Beli 0.1 SOL', `buy_quick_${tokenMint}_0.1`),
      Markup.button.callback('⚡ Beli 0.25 SOL', `buy_quick_${tokenMint}_0.25`)
    ],
    [
      Markup.button.url('📈 DexScreener', market.url)
    ]
  ];

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
}

// 3. COMMAND: /whales
bot.command('whales', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const page = parts.length > 1 ? parseInt(parts[1], 10) || 1 : 1;
  await renderWhalesList(ctx, page);
});

async function renderWhalesList(ctx: any, page: number = 1) {
  const whales = getAllWhales();
  const queue = getWhaleQueue();
  if (whales.length === 0) {
    return ctx.replyWithMarkdown(
      '🐋 Belum ada dompet paus di radar.\nKlik tombol di bawah atau gunakan `/scout` untuk memindai otomatis!',
      Markup.inlineKeyboard([[Markup.button.callback('🔍 Pindai Paus Sekarang', 'trigger_scout')]])
    );
  }

  const PAGE_SIZE = 5;
  const totalPages = Math.ceil(whales.length / PAGE_SIZE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const displayWhales = whales.slice(startIndex, startIndex + PAGE_SIZE);

  let text = `🐋 *RADAR DOMPET SMART MONEY (${whales.length}/${CONFIG.MAX_ACTIVE_WHALES})*\n` +
    `📋 *Shadow Queue:* *${queue.length} kandidat siap rotasi* | *Halaman ${currentPage}/${totalPages}*\n\n`;

  for (const w of displayWhales) {
    const isLossAlert = w.consecutive_losses > 0;
    const tierBadge = w.tier === 'VIP' ? '👑 VIP' : (w.tier === 'VERIFIED' ? '🎖️ VERIFIED' : '🔬 PROBATION');
    const autoCopyBadge = w.auto_copy ? '🟢 AUTO-COPY AKTIF' : '⏳ SHADOW (OBSERVASI)';
    const winRateText = w.total_trades_copied > 0
      ? `${(w.win_rate || 0).toFixed(1)}% (${w.wins || 0}W / ${w.losses || 0}L)`
      : 'Evaluasi Awal';

    const rolling = getWhaleRollingStats(w.label, CONFIG.ROLLING_WINDOW_DAYS);
    const rollingText = rolling.rollingTrades > 0
      ? `${rolling.rollingWinRate.toFixed(1)}% (${rolling.rollingWins}W/${rolling.rollingLosses}L, ${rolling.rollingPnlSol >= 0 ? '+' : ''}${rolling.rollingPnlSol.toFixed(3)} SOL)`
      : 'Belum Ada';

    text += `*#${w.id}* ${w.is_active ? '🟢' : '🔴'} ${tierBadge} *${w.label}*\n` +
      `• Alamat: \`${w.address}\`\n` +
      `• Mode: *${autoCopyBadge}* | Nominal: *${w.copy_amount_sol} SOL*\n` +
      `• Win Rate Total: *${winRateText}* | Copied: *${w.total_trades_copied}x*\n` +
      `• ⚡ Rolling 7-Day Alpha: *${rollingText}*\n` +
      `• Rekor PnL: *${w.total_pnl_sol >= 0 ? '+' : ''}${w.total_pnl_sol.toFixed(4)} SOL* | Loss Streak: *${w.consecutive_losses}* / ${CONFIG.MAX_CONSECUTIVE_LOSSES} ${isLossAlert ? '⚠️' : '✅'}\n` +
      `• Terakhir Aktif: ${w.last_trade_at ? w.last_trade_at.slice(0, 16).replace('T', ' ') : 'Baru'}\n\n`;
  }

  text += `_Perintah Otonom & Kontrol:_\n` +
    `• \`/scout\` - Pindai & rekrut kandidat baru\n` +
    `• \`/queue\` - Lihat antrean bangku cadangan\n` +
    `• \`/promote <id>\` - Promosikan manual | \`/delwhale <id>\` - Hapus`;

  const buttons: any[] = [];

  // Pagination navigation row
  if (totalPages > 1) {
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('⬅️ Prev', `whales_page_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`📄 ${currentPage} / ${totalPages}`, 'whales_noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `whales_page_${currentPage + 1}`));
    }
    buttons.push(navRow);
  }

  buttons.push([
    Markup.button.callback('🔍 Pindai Paus Baru', 'trigger_scout'),
    Markup.button.callback('🧹 Bersihkan Paus Buruk', 'trigger_prune')
  ]);
  buttons.push([
    Markup.button.callback(`📋 Bangku Cadangan (${queue.length})`, 'menu_queue'),
    Markup.button.callback('🕵️‍♂️ Audit Kluster Cabal', 'menu_cabal')
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
        await ctx.replyWithMarkdown(text, keyboard);
      });
    } else {
      await ctx.replyWithMarkdown(text, keyboard);
    }
  } catch (err: any) {
    console.error('[Telegram] Gagal render /whales:', err.message);
    await ctx.replyWithMarkdown(text.slice(0, 3900), keyboard);
  }
}

// COMMAND: /queue
bot.command('queue', async (ctx) => {
  await renderWhaleQueue(ctx);
});

async function renderWhaleQueue(ctx: any) {
  const queue = getWhaleQueue();
  const activeWhales = getAllWhales();

  if (queue.length === 0) {
    const emptyText = `📋 *SHADOW QUEUE SMART MONEY (KOSONG)*\n\n` +
      `Saat ini belum ada kandidat paus di bangku cadangan.\n` +
      `Kandidat baru yang lolos audit pro akan otomatis dialihkan ke antrean ini saat kuota radar aktif (*${activeWhales.length}/${CONFIG.MAX_ACTIVE_WHALES}*) telah penuh.\n\n` +
      `_Begitu ada paus aktif yang di-prune atau dihapus, kandidat teratas dari antrean ini akan langsung dipromosikan mengisi slot tersebut._`;
    return ctx.replyWithMarkdown(emptyText, Markup.inlineKeyboard([
      [
        Markup.button.callback('🔍 Pindai Scout Sekarang', 'trigger_scout'),
        Markup.button.callback('🐋 Radar Paus Aktif', 'menu_whales')
      ]
    ]));
  }

  let text = `📋 *SHADOW QUEUE SMART MONEY (${queue.length} KANDIDAT)*\n` +
    `_Kandidat lolos audit on-chain siap dipromosikan otomatis ke radar aktif:_\n\n`;

  // Display top 8 candidates
  const displayList = queue.slice(0, 8);
  for (const q of displayList) {
    text += `*#${q.id}* 🏷️ *${q.label}*\n` +
      `• Alamat: \`${q.address}\`\n` +
      `• Arketipe: *${q.archetype}*\n` +
      `• Saldo On-Chain: *${q.balance_sol.toFixed(2)} SOL* | Skor: *${q.score.toFixed(1)}*\n` +
      `• Kolam Asal: ${q.reference_pool || 'Solana Pool'}\n` +
      `• Waktu Temuan: ${q.created_at.slice(0, 16).replace('T', ' ')}\n\n`;
  }

  if (queue.length > 8) {
    text += `_... dan ${queue.length - 8} kandidat lainnya di antrean._\n\n`;
  }

  text += `_Perintah Kontrol Queue:_\n` +
    `• \`/promotequeue <id>\` - Promosikan kandidat tertentu ke radar aktif\n` +
    `• \`/popqueue\` - Promosikan kandidat teratas sekarang\n` +
    `• \`/delqueue <id>\` - Hapus kandidat dari antrean`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Promosikan Top Kandidat', 'promote_queue_top'),
      Markup.button.callback('🧹 Bersihkan Queue', 'clear_queue')
    ],
    [
      Markup.button.callback('🔍 Pindai Scout Sekarang', 'trigger_scout'),
      Markup.button.callback('🐋 Radar Paus Aktif', 'menu_whales')
    ]
  ]);

  await ctx.replyWithMarkdown(text, keyboard);
}

// COMMAND: /promotequeue <id>
bot.command('promotequeue', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/promotequeue <id>` (Lihat ID di `/queue`).');
  }

  const id = parseInt(parts[1], 10);
  if (isNaN(id)) {
    return ctx.replyWithMarkdown('❌ ID harus berupa angka.');
  }

  const currentWhales = getAllWhales();
  if (currentWhales.length >= CONFIG.MAX_ACTIVE_WHALES) {
    return ctx.replyWithMarkdown(
      `⚠️ *Radar aktif penuh (${currentWhales.length}/${CONFIG.MAX_ACTIVE_WHALES})!*\n` +
      `Hapus atau prune dompet aktif terlebih dahulu dengan \`/prune\` atau \`/delwhale <id>\`.`
    );
  }

  const candidate = getQueueWhaleById(id);
  if (!candidate) {
    return ctx.replyWithMarkdown(`❌ Kandidat queue #${id} tidak ditemukan.`);
  }

  const promoted = promoteQueueWhaleToActive(id);
  if (promoted) {
    refreshWhaleSubscriptions();
    await ctx.replyWithMarkdown(
      `🎖️ *Kandidat #${id} Berhasil Dipromosikan ke Radar Aktif!*\n\n` +
      `🏷️ *Label:* ${promoted.label} [${promoted.tier}]\n` +
      `📝 *Alamat:* \`${promoted.address}\`\n` +
      `Pipa WebSocket realtime Solana RPC langsung aktif memantau transaksi dompet ini.`
    );
  } else {
    await ctx.replyWithMarkdown(`❌ Gagal mempromosikan kandidat #${id}.`);
  }
});

// COMMAND: /popqueue
bot.command('popqueue', async (ctx) => {
  const currentWhales = getAllWhales();
  if (currentWhales.length >= CONFIG.MAX_ACTIVE_WHALES) {
    return ctx.replyWithMarkdown(
      `⚠️ *Radar aktif penuh (${currentWhales.length}/${CONFIG.MAX_ACTIVE_WHALES})!*\n` +
      `Hapus atau prune dompet aktif terlebih dahulu dengan \`/prune\` atau \`/delwhale <id>\`.`
    );
  }

  const promoted = promoteQueueWhaleToActive();
  if (promoted) {
    refreshWhaleSubscriptions();
    await ctx.replyWithMarkdown(
      `🎖️ *Top Kandidat Berhasil Dipromosikan ke Radar Aktif!*\n\n` +
      `🏷️ *Label:* ${promoted.label} [${promoted.tier}]\n` +
      `📝 *Alamat:* \`${promoted.address}\`\n` +
      `Pipa WebSocket realtime Solana RPC langsung aktif memantau transaksi dompet ini.`
    );
  } else {
    await ctx.replyWithMarkdown('ℹ️ Shadow Queue kosong, tidak ada kandidat untuk dipromosikan.');
  }
});

// COMMAND: /delqueue <id>
bot.command('delqueue', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/delqueue <id>` (Lihat ID di `/queue`).');
  }

  const id = parts[1];
  const success = removeFromWhaleQueue(id);
  if (success) {
    await ctx.replyWithMarkdown(`✅ Kandidat queue #${id} berhasil dihapus dari antrean.`);
  } else {
    await ctx.replyWithMarkdown(`❌ Gagal menghapus kandidat #${id} dari antrean.`);
  }
});

// COMMAND: /promote <id>
bot.command('promote', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/promote <id>` (Lihat ID di `/whales`).');
  }
  const id = parts[1];
  const success = promoteWhale(id);
  if (success) {
    refreshWhaleSubscriptions();
    await ctx.replyWithMarkdown(`🎖️ *Dompet Paus #${id} Berhasil Dipromosikan ke VERIFIED!* Auto-Copy diaktifkan.`);
  } else {
    await ctx.replyWithMarkdown(`❌ Gagal mempromosikan dompet #${id}.`);
  }
});

// COMMAND: /demote <id>
bot.command('demote', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/demote <id>` (Lihat ID di `/whales`).');
  }
  const id = parts[1];
  const success = demoteWhale(id);
  if (success) {
    refreshWhaleSubscriptions();
    await ctx.replyWithMarkdown(`🔬 *Dompet Paus #${id} Diturunkan ke PROBATION (Observasi).* Auto-Copy dinonaktifkan.`);
  } else {
    await ctx.replyWithMarkdown(`❌ Gagal mengubah status dompet #${id}.`);
  }
});

// COMMAND: /scout [jumlah]
bot.command('scout', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  let limit = CONFIG.WHALE_SCOUT_BATCH_SIZE || 4;
  if (parts.length > 1) {
    const parsed = parseInt(parts[1], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 10) {
      limit = parsed;
    }
  }
  // Run asynchronously so Telegram message loop is not blocked
  handleScoutExecution(ctx, limit).catch((err) => {
    console.error('[Telegram] Scout error:', err.message);
  });
});

async function handleScoutExecution(ctx: any, limitToRecruit: number = CONFIG.WHALE_SCOUT_BATCH_SIZE || 4) {
  const currentWhales = getAllWhales();
  const currentQueue = getWhaleQueue();
  const isRosterFull = currentWhales.length >= CONFIG.MAX_ACTIVE_WHALES;

  if (isRosterFull && currentQueue.length >= 50) {
    const text = `⚠️ *RADAR PAUS & SHADOW QUEUE PENUH (${currentWhales.length}/${CONFIG.MAX_ACTIVE_WHALES})!*\n\n` +
      `Seluruh slot kuota pemantauan aktif (${currentWhales.length}) dan antrean cadangan (${currentQueue.length}) saat ini sudah terisi penuh.\n\n` +
      `💡 *Solusi:*\n` +
      `• Klik *🧹 Bersihkan Paus* untuk mengeliminasi dompet berkinerja buruk via \`/prune\`\n` +
      `• Gunakan \`/delwhale <id>\` untuk menghapus manual (lihat ID di \`/whales\`)\n` +
      `• Gunakan \`/queue\` untuk mengelola bangku cadangan.`;
    return ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
      [
        Markup.button.callback('🧹 Bersihkan Paus Buruk', 'trigger_prune'),
        Markup.button.callback('📋 Bangku Cadangan', 'menu_queue')
      ]
    ]));
  }

  let introMsg = `🔍 *Memulai pemindaian institusional pasar Solana (Target: ${limitToRecruit} Paus)...*\n` +
    `Memindai 16 pool likuiditas multi-tier (Viral Trending + Fresh Breakouts), mengeliminasi bot MEV micro-flip (<90s), dan mengaudit saldo >= ${CONFIG.MIN_WHALE_BALANCE_SOL} SOL...`;

  if (isRosterFull) {
    introMsg += `\n\n_ℹ️ Kuota radar aktif penuh (${currentWhales.length}/${CONFIG.MAX_ACTIVE_WHALES}). Kandidat yang lolos audit akan otomatis dimasukkan ke Shadow Queue (Bangku Cadangan)._`;
  }

  await ctx.replyWithMarkdown(introMsg);

  const result = await scoutTrendingWhales(limitToRecruit);

  if (result.recruited > 0 && result.queued > 0) {
    await ctx.replyWithMarkdown(
      `✅ *Pemindaian Selesai!*\n` +
      `• Direkrut ke Radar Aktif: *${result.recruited} paus*\n` +
      `• Ditambahkan ke Shadow Queue: *${result.queued} kandidat*\n\n` +
      `Gunakan \`/whales\` untuk melihat radar aktif atau \`/queue\` untuk melihat bangku cadangan.`
    );
  } else if (result.recruited > 0) {
    await ctx.replyWithMarkdown(`✅ *Selesai!* Berhasil merekrut *${result.recruited} kandidat smart money baru* yang lolos audit pro ke radar aktif.`);
  } else if (result.queued > 0) {
    await ctx.replyWithMarkdown(
      `📋 *Selesai!* Berhasil menambahkan *${result.queued} kandidat smart money baru* ke *Shadow Queue (Bangku Cadangan)*.\n` +
      `Kandidat ini akan otomatis dipromosikan saat slot radar aktif tersedia.`
    );
  } else {
    await ctx.replyWithMarkdown(
      `ℹ️ *Pemindaian Selesai: Belum Ada Kandidat Baru.*\n\n` +
      `Dari transaksi pool organik terbaru, belum ada pembeli baru yang memenuhi seluruh standar pro:\n` +
      `• Saldo on-chain >= ${CONFIG.MIN_WHALE_BALANCE_SOL} SOL\n` +
      `• Pembelian minimal >= ${CONFIG.MIN_WHALE_BUY_SOL} SOL\n` +
      `• Bukan bot MEV (Holding style >= 90 detik)\n` +
      `• Bukan sindikat cabal / dev funder\n\n` +
      `_Bot akan memindai ulang secara otomatis setiap ${CONFIG.WHALE_DISCOVERY_INTERVAL_MIN} menit._`
    );
  }
}

// COMMAND: /prune
bot.command('prune', async (ctx) => {
  await ctx.replyWithMarkdown('🧹 *Memeriksa performa seluruh dompet paus di database...*');
  const count = await pruneUnderperformingWhales();
  if (count > 0) {
    await ctx.replyWithMarkdown(`✂️ *Selesai!* Berhasil mengeliminasi *${count} dompet* dengan performa buruk atau tidak aktif (Auto-substitution memeriksa antrean cadangan).`);
  } else {
    await ctx.replyWithMarkdown('✅ *Semua dompet paus berkinerja baik dan aktif!* Tidak ada yang perlu dieliminasi saat ini.');
  }
});

// COMMAND: /blacklist [address] [reason]
bot.command('blacklist', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length === 1) {
    const list = getBlacklistedWhales();
    if (list.length === 0) {
      return ctx.replyWithMarkdown('🛡️ *DAFTAR BLACKLIST DOMPET*\n\n_Belum ada dompet paus yang masuk daftar blacklist._');
    }
    let text = `🛡️ *DAFTAR BLACKLIST DOMPET (${list.length})*\n_Dompet berikut diblokir permanen dari radar & tidak akan pernah direkrut ulang:_\n\n`;
    list.slice(0, 15).forEach((b, idx) => {
      text += `*${idx + 1}.* \`${b.address.slice(0, 6)}...${b.address.slice(-6)}\`\n• Alasan: _${b.reason}_\n• Tanggal: ${b.blacklisted_at.slice(0, 10)}\n\n`;
    });
    return ctx.replyWithMarkdown(text);
  }

  const address = parts[1];
  const reason = parts.slice(2).join(' ') || 'Manual Blacklist via Telegram';
  if (address.length < 32 || address.length > 44) {
    return ctx.replyWithMarkdown('❌ Alamat Solana tidak valid (panjang karakter tidak sesuai).');
  }

  removeWhale(address, reason);
  blacklistWhale(address, reason);
  refreshWhaleSubscriptions();
  await ctx.replyWithMarkdown(`🚫 *Dompet Resmi Dimasukkan ke Blacklist!*\n\n📝 *Alamat:* \`${address}\`\n⚠️ *Alasan:* ${reason}\n\n_Dompet ini telah dicopot dari radar aktif dan diharamkan selamanya untuk direkrut ulang._`);
});

// COMMAND: /unblacklist <address>
bot.command('unblacklist', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Format salah!\nGunakan: `/unblacklist <alamat_solana>`');
  }
  const address = parts[1];
  unblacklistWhale(address);
  await ctx.replyWithMarkdown(`✅ *Dompet Dihapus dari Blacklist!*\n\n📝 *Alamat:* \`${address}\` sekarang diizinkan kembali masuk radar.`);
});

// COMMAND: /watch
bot.command('watch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  addWatcher(userId, ctx.from?.username, ctx.from?.first_name);
  await ctx.replyWithMarkdown(
    `🔔 *Mode Watcher Aktif!*\n\n` +
    `Mulai sekarang, kamu akan menerima notifikasi otomatis setiap kali ada pergerakan paus smart money on-chain, aksi akumulasi, atau sinyal take-profit.\n\n` +
    `_Ketik \`/unwatch\` kapan saja jika ingin berhenti berlangganan notifikasi._`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💼 Lihat Posisi Aktif', 'menu_positions')],
      [Markup.button.callback('🔕 Berhenti Notifikasi', 'action_unwatch')]
    ])
  );
});

// COMMAND: /unwatch
bot.command('unwatch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  removeWatcher(userId);
  await ctx.replyWithMarkdown(
    `🔕 *Notifikasi Watcher Dinonaktifkan.*\n\n` +
    `Kamu tidak akan menerima alert otomatis lagi. Kamu tetap bisa mengecek posisi koin secara manual lewat \`/positions\` atau \`/whales\` kapan saja.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔔 Aktifkan Kembali Notifikasi', 'action_watch')]
    ])
  );
});

// Watcher Action Callbacks
bot.action('action_watch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  addWatcher(userId, ctx.from?.username, ctx.from?.first_name);
  await ctx.answerCbQuery('🔔 Mode Watcher Aktif!');
  await ctx.replyWithMarkdown(`🔔 *Alert Sinyal Aktif!* Kamu akan menerima notifikasi otomatis setiap ada paus bertransaksi.`);
});

bot.action('action_unwatch', async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  removeWatcher(userId);
  await ctx.answerCbQuery('🔕 Notifikasi Dimatikan');
  await ctx.replyWithMarkdown(`🔕 *Notifikasi Dimatikan.* Ketik \`/watch\` untuk menyalakan kembali.`);
});

// 4. COMMAND: /addwhale <address> <label>
bot.command('addwhale', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    return ctx.replyWithMarkdown('Format salah!\nGunakan: `/addwhale <alamat_solana> <nama_label>`\nContoh:\n`/addwhale 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1 Paus Raydium Master`');
  }

  const address = parts[1];
  const label = parts.slice(2).join(' ');

  if (address.length < 32 || address.length > 44) {
    return ctx.replyWithMarkdown('❌ Alamat Solana tidak valid (panjang karakter tidak sesuai).');
  }

  const success = addWhale(address, label);
  if (success) {
    refreshWhaleSubscriptions();
    await ctx.replyWithMarkdown(`✅ *Dompet Paus Berhasil Ditambahkan!*\n\n🏷️ *Label:* ${label}\n📝 *Alamat:* \`${address}\`\n_Pipa WebSocket realtime (<400ms) langsung aktif memantau transaksi dompet ini._`);
  } else {
    await ctx.replyWithMarkdown('⚠️ Gagal menambahkan dompet (alamat sudah terdaftar di radar).');
  }
});

// 5. COMMAND: /delwhale <id>
bot.command('delwhale', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/delwhale <id>`\nContoh: `/delwhale 2` (Lihat ID di menu `/whales`).');
  }

  const id = parts[1];
  const success = removeWhale(id);
  if (success) {
    refreshWhaleSubscriptions();
    let replyMsg = `✅ Dompet paus #${id} berhasil dihapus dari radar.`;

    // Auto-Substitution: promote top queue candidate if available
    const promoted = promoteQueueWhaleToActive();
    if (promoted) {
      refreshWhaleSubscriptions();
      replyMsg += `\n\n🔄 *Auto-Substitution:* Kandidat dari Shadow Queue *${promoted.label}* (\`${promoted.address.slice(0, 4)}...${promoted.address.slice(-4)}\`) otomatis dipromosikan menggantikan slot kosong!`;
    }

    await ctx.replyWithMarkdown(replyMsg);
  } else {
    await ctx.replyWithMarkdown(`❌ Gagal menghapus dompet #${id}.`);
  }
});

// 6. COMMAND: /positions
bot.command('positions', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const page = parts.length > 1 ? parseInt(parts[1], 10) || 1 : 1;
  await renderPositions(ctx, page);
});

function formatPrice(val: number): string {
  if (!val) return '$0.00';
  if (val < 0.000001) return '$' + val.toExponential(3);
  if (val < 0.01) return '$' + val.toFixed(6);
  if (val < 1) return '$' + val.toFixed(4);
  return '$' + val.toFixed(2);
}

function getDurationText(openedAt: string): string {
  const diffMs = Date.now() - new Date(openedAt).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Baru saja (<1m)';
  if (diffMin < 60) return `${diffMin}m yang lalu`;
  const diffHours = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  return `${diffHours}j ${remMin}m yang lalu`;
}

async function renderPositions(ctx: any, page: number = 1) {
  const positions = getOpenPositions();
  const cashBalanceSol = getPaperBalance();
  const solPrice = await getSolPriceUsd();

  if (positions.length === 0) {
    return ctx.replyWithMarkdown(
      `💼 *POSISI TRADE AKTIF (0/${CONFIG.MAX_OPEN_POSITIONS})*\n\n` +
      `💰 *Kas Tersedia:* *${cashBalanceSol.toFixed(3)} SOL* (~$${(cashBalanceSol * solPrice).toFixed(2)})\n` +
      `📊 *Status:* Tidak ada posisi terbuka saat ini (100% modal aman dalam kas).\n\n` +
      `_Bot akan membuka posisi otomatis saat dompet paus terverifikasi membeli koin aman, atau kamu bisa paste CA untuk beli manual._`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Pindai Scout Sekarang', 'trigger_scout'), Markup.button.callback('🐋 Radar Paus', 'menu_whales')]
      ])
    );
  }

  let totalInvestedSol = 0;
  let totalCurrentValueUsd = 0;
  let totalUnrealizedPnlUsd = 0;

  for (const p of positions) {
    totalInvestedSol += p.entry_sol;
    totalCurrentValueUsd += (p.amount_tokens * p.current_price_usd);
    totalUnrealizedPnlUsd += (p.pnl_usd || 0);
  }

  const totalCurrentValueSol = solPrice > 0 ? totalCurrentValueUsd / solPrice : totalInvestedSol;
  const totalUnrealizedPnlSol = solPrice > 0 ? totalUnrealizedPnlUsd / solPrice : 0;
  const totalEquitySol = cashBalanceSol + totalCurrentValueSol;
  const totalEquityUsd = totalEquitySol * solPrice;
  const unrealizedPnlPct = totalInvestedSol > 0 ? (totalUnrealizedPnlSol / totalInvestedSol) * 100 : 0;
  const isTotalProfit = totalUnrealizedPnlUsd >= 0;

  const PAGE_SIZE = 4;
  const totalPages = Math.ceil(positions.length / PAGE_SIZE) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const displayPositions = positions.slice(startIndex, startIndex + PAGE_SIZE);

  let text = `💼 *RINGKASAN PORTOFOLIO & TRADE AKTIF*\n\n` +
    `💰 *Kas Bebas:* *${cashBalanceSol.toFixed(3)} SOL* (~$${(cashBalanceSol * solPrice).toFixed(2)})\n` +
    `🪙 *Modal Tertanam:* *${totalInvestedSol.toFixed(3)} SOL* (~$${(totalInvestedSol * solPrice).toFixed(2)}) (${positions.length}/${CONFIG.MAX_OPEN_POSITIONS} Posisi)\n` +
    `📊 *Total Ekuitas Portofolio:* *${totalEquitySol.toFixed(3)} SOL* (~$${totalEquityUsd.toFixed(2)})\n` +
    `📈 *Total Floating PnL:* *${isTotalProfit ? '+' : ''}${unrealizedPnlPct.toFixed(2)}%* ${isTotalProfit ? '🟢' : '🔴'} ` +
    `(*${isTotalProfit ? '+' : ''}${totalUnrealizedPnlSol.toFixed(4)} SOL* / *${isTotalProfit ? '+' : ''}$${totalUnrealizedPnlUsd.toFixed(2)}*)\n\n` +
    `───────────────────\n` +
    `📋 *RINCIAN TIAP TOKEN AKTIF (Hal ${currentPage}/${totalPages}):*\n\n`;

  for (const p of displayPositions) {
    const isProfit = p.pnl_pct >= 0;
    const tpPct = p.target_tp_pct || CONFIG.TAKE_PROFIT_PCT;
    const slPct = p.target_sl_pct || CONFIG.STOP_LOSS_PCT;

    const tpPrice = p.entry_price_usd * (1 + tpPct / 100);
    const slPrice = p.entry_price_usd * (1 - slPct / 100);
    const distToTp = tpPct - p.pnl_pct;
    const distToSl = p.pnl_pct - (-slPct);

    // Estimated roundtrip fee (Solana base gas + Jito priority tip ~0.002 SOL)
    const estFeeSol = 0.002;
    const estFeeUsd = estFeeSol * solPrice;
    const netPnlUsd = p.pnl_usd - estFeeUsd;
    const netProfit = netPnlUsd >= 0;

    const statusBadge = p.is_half_closed === 1
      ? '🌕 *STAGE 2 MOONBAG* (Modal 50% TP Aman)'
      : '🟢 *POSISI PENUH* (Menuju TP1)';

    text += `🪙 *#${p.id} ${p.token_symbol}* (${p.token_name})\n` +
      `• Status: ${statusBadge}\n` +
      `• Entry: *${formatPrice(p.entry_price_usd)}* | Sekarang: *${formatPrice(p.current_price_usd)}*\n` +
      `• Modal: *${p.entry_sol.toFixed(3)} SOL* (~$${(p.entry_sol * solPrice).toFixed(2)})\n` +
      `• Biaya Transaksi (Est. Gas/Tip): *~${estFeeSol} SOL* (~$${estFeeUsd.toFixed(2)})\n` +
      `• Gross PnL: *${isProfit ? '+' : ''}${p.pnl_pct.toFixed(2)}%* ${isProfit ? '🟢' : '🔴'} (*${p.pnl_usd >= 0 ? '+' : ''}$${p.pnl_usd.toFixed(2)}*)\n` +
      `• 💰 *Net Laba Bersih:* *${netProfit ? '+' : ''}$${netPnlUsd.toFixed(2)}* ${netProfit ? '🟢' : '🔴'}\n\n` +
      `🎯 *Target Take-Profit (TP):*\n` +
      `• Stage 1 TP (+${tpPct.toFixed(0)}%): *${formatPrice(tpPrice)}* (Kurang ${distToTp > 0 ? `+${distToTp.toFixed(1)}%` : 'Tercapai! 🚀'})\n` +
      `🛑 *Batas Stop-Loss (SL):*\n` +
      `• Hard Stop-Loss (-${slPct.toFixed(0)}%): *${formatPrice(slPrice)}* (Jarak aman: ${distToSl.toFixed(1)}%)\n`;

    if (p.peak_price_usd && p.peak_price_usd > p.entry_price_usd) {
      const trailingTriggerPrice = p.peak_price_usd * (1 - CONFIG.TRAILING_STOP_PCT / 100);
      text += `• Puncak ATH: *${formatPrice(p.peak_price_usd)}* | Trailing Trigger: *${formatPrice(trailingTriggerPrice)}*\n`;
    }

    text += `🏷️ Sinyal: _${p.whale_source || 'Whale Tracker'}_\n` +
      `⏱️ Dibuka: _${getDurationText(p.opened_at)}_\n\n` +
      `───────────────────\n\n`;
  }

  const buttons: any[] = [];

  // Pagination navigation row
  if (totalPages > 1) {
    const navRow: any[] = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('⬅️ Prev', `positions_page_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`📄 ${currentPage} / ${totalPages}`, 'positions_noop'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `positions_page_${currentPage + 1}`));
    }
    buttons.push(navRow);
  }

  for (const p of displayPositions) {
    buttons.push([
      Markup.button.callback(`💰 Jual ${p.token_symbol} (100%)`, `sell_100_${p.id}`)
    ]);
  }

  buttons.push([
    Markup.button.callback('🔄 Refresh Posisi', `positions_page_${currentPage}`),
    Markup.button.callback('📊 Laporan 24j', 'menu_report')
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(async () => {
        await ctx.replyWithMarkdown(text, keyboard);
      });
    } else {
      await ctx.replyWithMarkdown(text, keyboard);
    }
  } catch (err: any) {
    console.error('[Telegram] Gagal render /positions:', err.message);
    await ctx.replyWithMarkdown(text.slice(0, 3900), keyboard);
  }
}

// 7. COMMAND: /audit <token_address>
bot.command('audit', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/audit <alamat_token>`\nAtau cukup paste alamat kontrak (CA) langsung ke chat ini.');
  }
  await handleTokenAuditAndSnipe(ctx, parts[1]);
});

// 8. COMMAND: /buy <token_address> [amount_sol]
bot.command('buy', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/buy <alamat_token> [nominal_sol]`\nContoh:\n`/buy EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm 0.1`');
  }

  const tokenMint = parts[1];
  const amountSol = parts[2] ? parseFloat(parts[2]) : CONFIG.DEFAULT_BUY_AMOUNT_SOL;

  await ctx.replyWithMarkdown(`⚡ Memproses order beli *${amountSol} SOL* untuk \`${tokenMint}\`...`);
  const result = await executeBuyToken(tokenMint, amountSol, 'MANUAL_SNIPER');
  if (!result.success) {
    await ctx.replyWithMarkdown(`❌ Pembelian gagal: ${result.message}`);
  }
});

// 9. COMMAND: /sell <position_id>
bot.command('sell', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.replyWithMarkdown('Gunakan: `/sell <position_id>`\nContoh: `/sell 1` (Lihat ID di `/positions`).');
  }

  const posId = parseInt(parts[1], 10);
  const result = await executeSellToken(posId, 100, 'MANUAL_TELEGRAM');
  if (!result.success) {
    await ctx.replyWithMarkdown(`❌ Gagal menjual: ${result.message}`);
  }
});

// 10. COMMAND: /history
bot.command('history', async (ctx) => {
  const history = getTradeHistory(10);
  if (history.length === 0) {
    return ctx.replyWithMarkdown('📊 Belum ada riwayat transaksi yang selesai.');
  }

  let text = `📊 *RIWAYAT 10 TRANSAKSI TERAKHIR*\n\n`;
  for (const h of history) {
    const isBuy = h.action === 'BUY';
    const isProfit = h.pnl_pct >= 0;
    text += `${isBuy ? '🟢 *BELI*' : (isProfit ? '🎉 *JUAL TP*' : '🔴 *JUAL SL*')} *${h.token_symbol}*\n` +
      `• Nominal: ${h.total_sol.toFixed(3)} SOL\n` +
      (!isBuy ? `• PnL: *${isProfit ? '+' : ''}${h.pnl_pct.toFixed(2)}%* (${h.pnl_sol >= 0 ? '+' : ''}${h.pnl_sol.toFixed(4)} SOL)\n` : '') +
      `• Alasan: \`${h.reason}\`\n` +
      `• Waktu: ${h.timestamp.slice(11, 19)} UTC\n\n`;
  }

  await ctx.replyWithMarkdown(text);
});

// 11. COMMAND: /resetpaper
bot.command('resetpaper', async (ctx) => {
  resetPaperBalance(CONFIG.INITIAL_PAPER_BALANCE_SOL);
  await ctx.replyWithMarkdown(`🔄 Saldo virtual Paper Trading telah direset kembali menjadi *${CONFIG.INITIAL_PAPER_BALANCE_SOL} SOL*!`);
});

// 12. COMMAND: /settings
bot.command('settings', async (ctx) => {
  const text = `⚙️ *PENGATURAN MESIN HEDGE FUND INSTITUSIONAL*\n\n` +
    `🧪 *Mode Trading:* ${CONFIG.PAPER_TRADING ? '🟢 Paper Trading (Simulasi $0 Risiko)' : '🔴 Live Trading (Uang Nyata)'}\n` +
    `💰 *Default Beli per Sinyal:* *${CONFIG.DEFAULT_BUY_AMOUNT_SOL} SOL*\n` +
    `🎯 *Stage 1 Take-Profit:* *+${CONFIG.TAKE_PROFIT_PCT}%* (Jual 50%, modal aman 100%)\n` +
    `🌕 *Stage 2 Moonbag Trailing Stop:* *${CONFIG.TRAILING_STOP_PCT}%* (Kawal sisa 50% hingga puncak)\n` +
    `🛑 *Batas Stop-Loss:* *-${CONFIG.STOP_LOSS_PCT}%*\n` +
    `⚡ *Slippage Maksimal:* *${CONFIG.SLIPPAGE_PCT}%*\n\n` +
    `🛡️ *Institutional Risk & Execution Controls:*\n` +
    `• Anti-Chase / Pucuk Guard: *Batal jika harga drift > +${CONFIG.MAX_PRICE_DRIFT_PCT}%*\n` +
    `• Anti-FOMO Spike: *Batal jika candle 5m > +${CONFIG.MAX_5M_PRICE_CHANGE_PCT}%*\n` +
    `• Minimal Likuiditas Pool: *$${formatNumber(CONFIG.MIN_LIQUIDITY_USD)}*\n` +
    `• Minimal Volume 24 Jam: *$${formatNumber(CONFIG.MIN_VOLUME_24H_USD)}*\n` +
    `• Minimal Market Cap: *$${formatNumber(CONFIG.MIN_MARKET_CAP_USD)}*\n` +
    `• Maksimal Posisi Terbuka: *${CONFIG.MAX_OPEN_POSITIONS} token simultan*\n` +
    `• 24h Time-Stop (Zombie Reaper): *Auto-likuidasi koin stagnan > ${CONFIG.MAX_HOLD_TIME_HOURS} jam*\n\n` +
    `🤖 *Autonomous Smart Money Scouting:*\n` +
    `• Filter Saldo Paus On-Chain: *>= ${CONFIG.MIN_WHALE_BALANCE_SOL} SOL*\n` +
    `• Filter Riwayat On-Chain: *>= ${CONFIG.MIN_WHALE_HISTORY_TXS} transaksi (Anti-Burner)*\n` +
    `• Status Awal Paus: *PROBATION (Masa Percobaan / Shadow Tracking)*\n` +
    `• Syarat Promosi: *Profit pada trade on-chain*\n` +
    `• Syarat Istirahat (Bench): *>= ${CONFIG.MAX_CONSECUTIVE_LOSSES_DEMOTE}x Stop-Loss (Masuk Shadow Mode, 0 Risiko)*\n` +
    `• Syarat Eliminasi Permanen: *>= ${CONFIG.MAX_CONSECUTIVE_LOSSES_PRUNE}x Stop-Loss* atau *Winrate < ${CONFIG.MIN_WINRATE_PCT}%*\n\n` +
    `_Semua parameter dapat disesuaikan di file \`.env\`._`;

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('🔍 Pindai Paus Sekarang', 'trigger_scout'),
      Markup.button.callback('🧹 Bersihkan Paus', 'trigger_prune')
    ],
    [Markup.button.callback('🔄 Reset Saldo Dummy ke 10 SOL', 'reset_paper_balance')]
  ]));
});

// Inline Keyboard Callbacks
bot.action('menu_whales', async (ctx) => {
  await ctx.answerCbQuery();
  await renderWhalesList(ctx, 1);
});

bot.action(/whales_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1], 10) || 1;
  await renderWhalesList(ctx, page);
});

bot.action('whales_noop', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action('menu_queue', async (ctx) => {
  await ctx.answerCbQuery();
  await renderWhaleQueue(ctx);
});

bot.action('promote_queue_top', async (ctx) => {
  await ctx.answerCbQuery('Mempromosikan...');
  const currentWhales = getAllWhales();
  if (currentWhales.length >= CONFIG.MAX_ACTIVE_WHALES) {
    return ctx.replyWithMarkdown(
      `⚠️ *Radar aktif sudah penuh (${currentWhales.length}/${CONFIG.MAX_ACTIVE_WHALES})!*\n` +
      `Gunakan \`/prune\` atau \`/delwhale <id>\` untuk membebaskan slot terlebih dahulu.`
    );
  }

  const promoted = promoteQueueWhaleToActive();
  if (promoted) {
    refreshWhaleSubscriptions();
    await ctx.replyWithMarkdown(
      `🎖️ *Top Kandidat Berhasil Dipromosikan ke Radar Aktif!*\n\n` +
      `🏷️ *Label:* ${promoted.label} [${promoted.tier}]\n` +
      `📝 *Alamat:* \`${promoted.address}\`\n` +
      `Pipa WebSocket realtime Solana RPC langsung aktif memantau transaksi dompet ini.`
    );
  } else {
    await ctx.replyWithMarkdown('ℹ️ Shadow Queue kosong, tidak ada kandidat untuk dipromosikan.');
  }
});

bot.action('clear_queue', async (ctx) => {
  await ctx.answerCbQuery('Membersihkan queue...');
  const count = clearWhaleQueue();
  await ctx.replyWithMarkdown(`🧹 *Shadow Queue Dibersihkan:* *${count} kandidat* telah dihapus dari antrean.`);
});

bot.action('trigger_scout', async (ctx) => {
  await ctx.answerCbQuery('Memulai pemindaian...');
  handleScoutExecution(ctx).catch((err) => {
    console.error('[Telegram] Scout error:', err.message);
  });
});

bot.action('trigger_prune', async (ctx) => {
  await ctx.answerCbQuery('Memeriksa performa...');
  const count = await pruneUnderperformingWhales();
  if (count > 0) {
    await ctx.replyWithMarkdown(`✂️ Berhasil mengeliminasi *${count} dompet* berkinerja buruk.`);
  } else {
    await ctx.replyWithMarkdown('✅ Semua dompet paus saat ini sehat!');
  }
});

bot.action('menu_positions', async (ctx) => {
  await ctx.answerCbQuery();
  await renderPositions(ctx, 1);
});

bot.action(/positions_page_(\d+)/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1], 10) || 1;
  await renderPositions(ctx, page);
});

bot.action('positions_noop', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action('menu_history', async (ctx) => {
  await ctx.answerCbQuery();
  const stats = getTradingStats();
  const history = getTradeHistory(5);
  let text = `📊 *STATISTIK & RIWAYAT*\n\n` +
    `• Total Trade Selesai: *${stats.totalTrades}*\n` +
    `• Menang: *${stats.winTrades}* | Kalah: *${stats.lossTrades}*\n` +
    `• Win Rate: *${stats.winRate}%*\n` +
    `• Total PnL: *$${stats.totalPnlUsd}*\n\n`;

  if (history.length > 0) {
    text += `*5 Trade Terakhir:*\n`;
    for (const h of history) {
      text += `• ${h.action} ${h.token_symbol} (${h.pnl_pct >= 0 ? '+' : ''}${h.pnl_pct.toFixed(1)}%)\n`;
    }
  }

  await ctx.replyWithMarkdown(text);
});

bot.action('menu_settings', async (ctx) => {
  await ctx.answerCbQuery();
  const text = `⚙️ *PARAMETER QUANT HEDGE FUND (GOD-TIER)*\n\n` +
    `• In-Memory AMM Math: *✅ AKTIF (Sub-Mikrodetik)*\n` +
    `• Kelly Sizing Formula: *✅ Fractional Kelly (${CONFIG.KELLY_FRACTION * 100}%)*\n` +
    `• Max Pool Depth Cap: *${CONFIG.MAX_LIQUIDITY_DEPTH_PCT}% dari Likuiditas*\n` +
    `• Flash-Exit Rug Buster: *${CONFIG.FLASH_EXIT_ENABLED ? `✅ Auto-Dump >${CONFIG.FLASH_EXIT_DROP_PCT}%` : '❌ Nonaktif'}*\n` +
    `• High-Freq Tick Loop: *${CONFIG.POSITION_CHECK_INTERVAL_SEC} Detik*\n` +
    `• Whale Copy-Sell Sync: *${CONFIG.COPY_SELL_ENABLED ? '✅ AKTIF (<400ms)' : '❌ NONAKTIF'}*\n` +
    `• Jito MEV Anti-Sandwich: *${CONFIG.JITO_MEV_ENABLED ? '✅ AKTIF (Private Mempool)' : '❌ NONAKTIF'}*\n` +
    `• Cabal Sybil Shield: *${CONFIG.CABAL_SHIELD_ENABLED ? '✅ AKTIF (On-Chain Trace)' : '❌ NONAKTIF'}*\n` +
    `• Circuit Breaker: *Maks ${CONFIG.CIRCUIT_BREAKER_MAX_DAILY_LOSSES} SL -> Cooldown ${CONFIG.CIRCUIT_BREAKER_COOLDOWN_HOURS} Jam*`;
  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Laporan 24 Jam', 'menu_report'),
      Markup.button.callback('📐 Rumus Kelly', 'menu_kelly')
    ],
    [
      Markup.button.callback('🕵️‍♂️ Audit Cabal', 'menu_cabal'),
      Markup.button.callback('🐋 Radar Paus', 'menu_whales')
    ]
  ]));
});

// COMMAND: /report & /pnl
bot.command(['report', 'pnl'], async (ctx) => {
  await renderReport(ctx);
});

bot.action('menu_report', async (ctx) => {
  await ctx.answerCbQuery();
  await renderReport(ctx);
});

async function renderReport(ctx: any) {
  const daily = getDailyRealizedPnl();
  const quant = getPortfolioQuantMetrics();
  const solPrice = await getSolPriceUsd();
  const grossPnlUsd = daily.grossPnlSol * solPrice;
  const netPnlUsd = daily.netPnlSol * solPrice;
  const feesUsd = daily.totalFeesSol * solPrice;
  const cb = isCircuitBreakerActive();
  const dailyLosses = getDailyStopLossCount();
  const balanceSol = getPaperBalance();
  const openPositions = getOpenPositions();

  let text = `📊 *LAPORAN PERFORMA & QUANT JOURNAL (24 JAM)*\n\n` +
    `💵 *Kinerja Realized PnL (True Net Accounting):*\n` +
    `• Gross Laba Kotor: *${daily.grossPnlSol >= 0 ? '+' : ''}${daily.grossPnlSol.toFixed(4)} SOL* (~$${grossPnlUsd.toFixed(2)})\n` +
    `• Biaya On-Chain (Gas/Tip): *-${daily.totalFeesSol.toFixed(4)} SOL* (~$${feesUsd.toFixed(2)})\n` +
    `• 💰 *Net Laba Bersih:* *${daily.netPnlSol >= 0 ? '+' : ''}${daily.netPnlSol.toFixed(4)} SOL* (~$${netPnlUsd.toFixed(2)}) ${daily.netPnlSol >= 0 ? '🟢' : '🔴'}\n\n` +
    `📈 *Metrik Eksekusi:*\n` +
    `• Total Trade Selesai: *${daily.totalTrades}*\n` +
    `• Win Rate: *${daily.winRate}%* (${daily.winTrades}W / ${daily.lossTrades}L)\n` +
    `• Cadangan Kas: *${balanceSol.toFixed(3)} SOL* (~$${(balanceSol * solPrice).toFixed(2)})\n` +
    `• Eksposur Portofolio: *${openPositions.length}/${CONFIG.MAX_OPEN_POSITIONS}* token aktif\n\n` +
    `📐 *Rasio Risiko & Kinerja Quant Portofolio:*\n` +
    `• Sharpe Ratio: *${quant.sharpeRatio}* | Sortino: *${quant.sortinoRatio}*\n` +
    `• Profit Factor: *${quant.profitFactor}* | Max Drawdown: *${quant.maxDrawdownPct}%*\n\n`;

  if (daily.bestTrade) {
    text += `🌟 *Best Trade (24j):* ${daily.bestTrade.symbol} (*+${daily.bestTrade.pnlPct.toFixed(1)}%*, Net: +${daily.bestTrade.netPnlSol.toFixed(4)} SOL)\n`;
  }
  if (daily.worstTrade && daily.worstTrade.pnlPct < 0) {
    text += `🔻 *Worst Trade (24j):* ${daily.worstTrade.symbol} (*${daily.worstTrade.pnlPct.toFixed(1)}%*, Net: ${daily.worstTrade.netPnlSol.toFixed(4)} SOL)\n`;
  }

  text += `\n🛡️ *Kesehatan Sistem & Circuit Breaker:*\n`;
  if (cb.active) {
    const remainingMins = Math.ceil((cb.untilMs - Date.now()) / (60 * 1000));
    text += `• Status: 🛑 *TRIPPED / DIBEKUKAN*\n` +
      `• Alasan: ${cb.reason}\n` +
      `• Sisa Cooldown: *${remainingMins} menit*\n` +
      `_Gunakan /resetcb untuk membuka kunci jika kondisi pasar telah aman._\n`;
  } else {
    text += `• Status: ✅ *NORMAL / SIAP TEMPUR*\n` +
      `• SL 24 Jam: *${dailyLosses}/${CONFIG.CIRCUIT_BREAKER_MAX_DAILY_LOSSES}*\n` +
      `• Copy-Sell Synchronization: *${CONFIG.COPY_SELL_ENABLED ? '✅ AKTIF' : '❌ NONAKTIF'}*\n`;
  }

  const buttons: any[] = [
    [
      Markup.button.callback('📐 Metrik Quant', 'menu_quant'),
      Markup.button.callback('🔬 Uji Backtest', 'menu_backtest')
    ],
    [
      Markup.button.callback('💼 Posisi Aktif', 'menu_positions'),
      Markup.button.callback('🐋 Radar Paus', 'menu_whales')
    ]
  ];

  if (cb.active) {
    buttons.push([Markup.button.callback('🔓 Reset Circuit Breaker Manual', 'reset_circuit_breaker')]);
  }

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
}

// COMMAND: /resetcb
bot.command('resetcb', async (ctx) => {
  resetCircuitBreaker();
  await ctx.replyWithMarkdown('✅ *Circuit Breaker berhasil direset!* Bot sekarang siap membuka order kembali.');
});

bot.action('reset_circuit_breaker', async (ctx) => {
  await ctx.answerCbQuery('Circuit Breaker direset!');
  resetCircuitBreaker();
  await ctx.replyWithMarkdown('✅ *Circuit Breaker berhasil direset!* Bot sekarang siap membuka order kembali.');
});

// COMMAND: /cabal
bot.command('cabal', async (ctx) => {
  await handleCabalAudit(ctx);
});

bot.action('menu_cabal', async (ctx) => {
  await ctx.answerCbQuery('Memulai audit kluster cabal...');
  await handleCabalAudit(ctx);
});

async function handleCabalAudit(ctx: any) {
  await ctx.replyWithMarkdown('🕵️‍♂️ *Menganalisis Riwayat On-Chain Seluruh Paus...*\n_Melacak jejak penyetor dana awal (funder trace) untuk mendeteksi sindikat dev scam..._');
  const whales = getAllWhales();
  const audit = await auditAllWhalesForClusters(whales);

  let text = `🕵️‍♂️ *LAPORAN AUDIT KLUSTER CABAL & SYBIL*\n\n` +
    `• Total Dompet Paus Diaudit: *${whales.length}*\n` +
    `• Dompet Bersih (Independen): *${audit.cleanCount}* ✅\n` +
    `• Kluster Komplotan Ditemukan: *${audit.clusters.length}* ${audit.clusters.length > 0 ? '⚠️' : '✅'}\n\n`;

  if (audit.clusters.length === 0) {
    text += `🛡️ *Hasil:* *SEMPURNA! Zero Cabal Detected.*\n` +
      `Seluruh dompet paus yang aktif memiliki sumber modal independen / CEX yang sah. Tidak ada indikasi komplotan dev scam atau wash-trading tersembunyi.`;
  } else {
    text += `⚠️ *PERINGATAN: KLUSTER SINDIKAT TERDETEKSI!*\n`;
    for (const c of audit.clusters) {
      text += `\n🔗 *Penyetor Bersama:* \`${c.funder}\`\n` +
        `• Anggota Kluster: ${c.whales.map(w => `*${w}*`).join(', ')}\n` +
        `_Rekomendasi: Turunkan salah satu atau hapus menggunakan /delwhale._\n`;
    }
  }

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('🐋 Radar Paus', 'menu_whales'),
      Markup.button.callback('🧹 Bersihkan Paus', 'trigger_prune')
    ]
  ]));
}

// COMMAND: /kelly
bot.command('kelly', async (ctx) => {
  await renderKellyInfo(ctx);
});

bot.action('menu_kelly', async (ctx) => {
  await ctx.answerCbQuery();
  await renderKellyInfo(ctx);
});

async function renderKellyInfo(ctx: any) {
  const balance = getPaperBalance();
  const solPrice = await getSolPriceUsd();
  const payoffB = (CONFIG.TAKE_PROFIT_PCT / CONFIG.STOP_LOSS_PCT).toFixed(2);

  const text = `📐 *ALOKASI MODAL MATEMATIS (FRACTIONAL KELLY CRITERION)*\n\n` +
    `Formula John L. Kelly Jr. yang digunakan hedge fund Wall Street untuk memaksimalkan laju pertumbuhan modal jangka panjang (*logarithmic wealth growth*) tanpa risiko kebangkrutan (*Gambler's Ruin*).\n\n` +
    `🧮 *Rumus Inti:*\n` +
    `\`f* = (p × b - q) / b\`\n` +
    `• \`p\` = Probabilitas Menang (Win Rate Paus)\n` +
    `• \`q\` = Probabilitas Kalah (1 - p)\n` +
    `• \`b\` = Payoff Ratio (*${payoffB}x* dari TP +${CONFIG.TAKE_PROFIT_PCT}% vs SL -${CONFIG.STOP_LOSS_PCT}%)\n\n` +
    `🛡️ *Pengaman Kuantitatif:*\n` +
    `• *Quarter-Kelly (${CONFIG.KELLY_FRACTION * 100}%):* Alokasi dipotong menjadi 1/4 Kelly demi meredam volatilitas drawdown portofolio.\n` +
    `• *Liquidity Depth Cap:* Alokasi dibatasi maksimal *${CONFIG.MAX_LIQUIDITY_DEPTH_PCT}%* dari total kedalaman pool agar tidak menderita slippage saat keluar.\n` +
    `• *Tier Ceiling:* Maksimal 0.25 SOL (VIP) / 0.15 SOL (Verified).\n\n` +
    `💼 *Saldo Tersedia Saat Ini:* *${balance.toFixed(3)} SOL* (~$${(balance * solPrice).toFixed(2)})\n` +
    `_Bot menghitung ukuran posisi dinamis setiap kali sinyal beli paus terdeteksi._`;

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Laporan 24 Jam', 'menu_report'),
      Markup.button.callback('⚙️ Pengaturan Engine', 'menu_settings')
    ]
  ]));
}

bot.action('reset_paper_balance', async (ctx) => {
  await ctx.answerCbQuery('Saldo direset!');
  resetPaperBalance(CONFIG.INITIAL_PAPER_BALANCE_SOL);
  await ctx.replyWithMarkdown(`🔄 Saldo virtual berhasil direset ke *${CONFIG.INITIAL_PAPER_BALANCE_SOL} SOL*!`);
});

// Inline Sell Action with Two-Step Confirmation (Anti-Accidental Tap)
bot.action(/sell_100_(\d+)/, async (ctx) => {
  const posId = parseInt(ctx.match[1], 10);
  const position = getOpenPositions().find((p: any) => p.id === posId);
  if (!position) {
    await ctx.answerCbQuery('⚠️ Posisi tidak ditemukan atau sudah ditutup.');
    return;
  }
  await ctx.answerCbQuery('⚠️ Konfirmasi penjualan dibutuhkan');

  const confirmKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`✅ Ya, Jual 100% #${posId}`, `confirm_sell_100_${posId}`),
      Markup.button.callback(`❌ Batalkan`, `cancel_sell_${posId}`)
    ]
  ]);

  const cleanSymbol = (position.token_symbol || '').replace(/[*_`]/g, '');
  await safeReplyWithMarkdown(
    ctx,
    `⚠️ *KONFIRMASI PENJUALAN MANUAL*\n\n` +
    `Anda akan menjual posisi berikut secara manual:\n` +
    `• Posisi: *#${posId}*\n` +
    `• Token: *${cleanSymbol}*\n` +
    `• Modal: *${position.entry_sol.toFixed(3)} SOL*\n\n` +
    `_Klik tombol konfirmasi di bawah ini untuk mengeksekusi, atau batalkan jika tidak sengaja tertekan._`,
    confirmKeyboard
  );
});

bot.action(/confirm_sell_100_(\d+)/, async (ctx) => {
  const posId = parseInt(ctx.match[1], 10);
  const position = getOpenPositions().find((p: any) => p.id === posId);
  if (!position) {
    await ctx.answerCbQuery('⚠️ Posisi sudah tidak aktif atau telah terjual.');
    try {
      await ctx.editMessageText(`ℹ️ *Posisi #${posId} sudah ditutup sebelumnya.*`, { parse_mode: 'Markdown' }).catch(() => {});
    } catch {}
    return;
  }

  await ctx.answerCbQuery('🚀 Mengeksekusi penjualan...');
  try {
    const cleanSymbol = (position.token_symbol || '').replace(/[*_`]/g, '');
    await ctx.editMessageText(`⏳ *Mengeksekusi penjualan posisi #${posId} (${cleanSymbol})...*`, { parse_mode: 'Markdown' }).catch(() => {});
  } catch {}

  const result = await executeSellToken(posId, 100, 'MANUAL_INLINE_BUTTON');
  if (!result.success) {
    await safeReplyWithMarkdown(ctx, `❌ *Gagal mengeksekusi penjualan:* ${result.message}`);
  }
});

bot.action(/cancel_sell_(\d+)/, async (ctx) => {
  const posId = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery('✅ Penjualan dibatalkan');
  try {
    await ctx.editMessageText(`🛡️ *Penjualan posisi #${posId} dibatalkan.* Posisi tetap aktif dan dikawal bot secara otomatis.`, { parse_mode: 'Markdown' }).catch(() => {});
  } catch {}
});

// Quick Buy Button Action from Token Card
bot.action(/buy_quick_([1-9A-HJ-NP-Za-km-z]{32,44})_([\d.]+)/, async (ctx) => {
  const tokenMint = ctx.match[1];
  const amountSol = parseFloat(ctx.match[2]);

  await ctx.answerCbQuery(`Mengeksekusi order ${amountSol} SOL...`);
  await ctx.replyWithMarkdown(`⚡ Memproses pembelian *${amountSol} SOL* untuk \`${tokenMint}\`...`);

  const result = await executeBuyToken(tokenMint, amountSol, 'MANUAL_SNIPER');
  if (!result.success) {
    await ctx.replyWithMarkdown(`❌ Pembelian gagal: ${result.message}`);
  }
});

// 13. COMMAND: /quant
bot.command('quant', async (ctx) => {
  await renderQuantMetrics(ctx);
});

bot.action('menu_quant', async (ctx) => {
  await ctx.answerCbQuery();
  await renderQuantMetrics(ctx);
});

async function renderQuantMetrics(ctx: any) {
  const metrics = getPortfolioQuantMetrics();
  const solPrice = await getSolPriceUsd();
  const netPnlUsd = metrics.netPnlSol * solPrice;

  let text = `📐 *AUDIT STATISTIK & METRIK KUANTITATIF (INSTITUSIONAL)*\n\n` +
    `Standar metrik hedge fund yang mengukur rasio imbal hasil terhadap volatilitas dan risiko kerugian modal:\n\n` +
    `📊 *Rasio Kinerja & Risiko:*\n` +
    `• *Sharpe Ratio:* *${metrics.sharpeRatio}* ${metrics.sharpeRatio >= 1.5 ? '🏆 (Elite Tier)' : (metrics.sharpeRatio >= 1.0 ? '✅ (Baik)' : '⚠️ (Fluktuatif)')}\n` +
    `  _Mengukur excess return terhadap total volatilitas portofolio._\n` +
    `• *Sortino Ratio:* *${metrics.sortinoRatio}* 💎\n` +
    `  _Hanya menghukum volatilitas penurunan (downside risk), ideal untuk koin meme asimetris._\n` +
    `• *Profit Factor:* *${metrics.profitFactor}* ${metrics.profitFactor >= 1.75 ? '🟢 (Prima)' : '🔻'}\n` +
    `  _Rasio total laba kotor dibagi total rugi kotor (standar Wall Street: >1.75)._\n` +
    `• *Max Drawdown (MDD):* *${metrics.maxDrawdownPct}%* (-${metrics.maxDrawdownSol.toFixed(4)} SOL)\n` +
    `  _Penurunan modal terdalam dari titik puncak equity curve._\n` +
    `• *Calmar Ratio:* *${metrics.calmarRatio}*\n` +
    `  _Rasio imbal hasil tahunan terhadap Max Drawdown._\n` +
    `• *Payoff Ratio (Win/Loss):* *${metrics.payoffRatio}x*\n` +
    `  _Rata-rata untung per trade vs rata-rata rugi per trade._\n` +
    `• *Trade Expectancy:* *${metrics.tradeExpectancySol >= 0 ? '+' : ''}${metrics.tradeExpectancySol.toFixed(4)} SOL / trade*\n` +
    `  _Nilai ekspektasi matematis keuntungan setiap kali bot mengeksekusi order._\n\n` +
    `💼 *Ringkasan Akuntansi Real:*\n` +
    `• Total Trade Selesai: *${metrics.totalTrades}* (${metrics.winTrades}W / ${metrics.lossTrades}L - *${metrics.winRatePct}%* Winrate)\n` +
    `• Gross PnL: *${metrics.grossPnlSol >= 0 ? '+' : ''}${metrics.grossPnlSol.toFixed(4)} SOL*\n` +
    `• Gas Drag & Jito Tips: *-${metrics.totalFeesSol.toFixed(4)} SOL*\n` +
    `• 💰 *Net Laba Bersih:* *${metrics.netPnlSol >= 0 ? '+' : ''}${metrics.netPnlSol.toFixed(4)} SOL* (~$${netPnlUsd.toFixed(2)})\n`;

  await ctx.replyWithMarkdown(text, Markup.inlineKeyboard([
    [
      Markup.button.callback('🔬 Uji Backtest Historis', 'menu_backtest'),
      Markup.button.callback('📊 Laporan 24 Jam', 'menu_report')
    ]
  ]));
}

// 14. COMMAND: /backtest [ca | regime]
bot.command('backtest', async (ctx) => {
  await handleBacktestCommand(ctx);
});

bot.action('menu_backtest', async (ctx) => {
  await ctx.answerCbQuery();
  await renderBacktestMenu(ctx);
});

async function renderBacktestMenu(ctx: any) {
  const text = `🔬 *INSTITUTIONAL QUANT BACKTEST ENGINE*\n\n` +
    `Uji keandalan strategi kuantitatif (Anti-Chase +6%, Dynamic TP/SL, 2-Stage Moonbag, Flash-Exit Rug Buster, Gas Drag) pada data historis nyata ataupun skenario stres pasar:\n\n` +
    `Pilih salah satu preset skenario atau ketik perintah manual:\n` +
    `• \`/backtest <alamat_token>\` - Uji replay candle on-chain riil (GeckoTerminal)\n` +
    `• \`/backtest <bull|chop|bloodbath|rug>\` - Uji simulasi stres regime pasar`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📈 Popcat (Candle Riil)', 'backtest_popcat'),
      Markup.button.callback('🐂 Skenario Bull Run', 'backtest_regime_bull')
    ],
    [
      Markup.button.callback('🦀 Skenario Choppy Crab', 'backtest_regime_chop'),
      Markup.button.callback('🩸 Skenario Bloodbath Crash', 'backtest_regime_bloodbath')
    ],
    [
      Markup.button.callback('🚀 Skenario Pump & Dump Arc', 'backtest_regime_pumpdump'),
      Markup.button.callback('📐 Metrik Quant Portofolio', 'menu_quant')
    ]
  ]);

  await ctx.replyWithMarkdown(text, keyboard);
}

async function handleBacktestCommand(ctx: any) {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length > 1) {
    const target = parts[1].toLowerCase();
    if (['bull', 'chop', 'bloodbath', 'pump_dump', 'rug'].includes(target)) {
      const regime = target === 'rug' ? 'PUMP_DUMP' : target.toUpperCase() as any;
      await runAndSendBacktest(ctx, regime, true);
      return;
    } else {
      await runAndSendBacktest(ctx, parts[1], false);
      return;
    }
  }
  await renderBacktestMenu(ctx);
}

async function runAndSendBacktest(ctx: any, target: string, isSynthetic: boolean) {
  await ctx.replyWithMarkdown(`⏳ *Mengambil data candle & mengeksekusi simulasi algoritma kuantitatif...*`);

  try {
    let report;
    if (isSynthetic) {
      const { candles, tokenSymbol } = generateSyntheticRegime(target as any, 60);
      report = runBacktest(candles, tokenSymbol);
    } else {
      const { candles, tokenSymbol } = await fetchHistoricalCandles(target, 'hour', 60);
      if (candles.length < 5) {
        await ctx.replyWithMarkdown(`❌ Gagal mengambil data candle historis untuk token tersebut. Pastikan token sudah memiliki pool likuiditas aktif di GeckoTerminal/DexScreener.`);
        return;
      }
      report = runBacktest(candles, tokenSymbol);
    }

    const reportText = formatBacktestTelegramReport(report);
    await ctx.replyWithMarkdown(reportText, Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Uji Skenario Lain', 'menu_backtest'),
        Markup.button.callback('📐 Metrik Quant', 'menu_quant')
      ]
    ]));
  } catch (err: any) {
    await ctx.replyWithMarkdown(`❌ Terjadi error saat backtesting: ${err.message}`);
  }
}

// Backtest Preset Callbacks
bot.action('backtest_popcat', async (ctx) => {
  await ctx.answerCbQuery('Memulai backtest Popcat...');
  await runAndSendBacktest(ctx, '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', false);
});

bot.action('backtest_regime_bull', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Bull Run...');
  await runAndSendBacktest(ctx, 'BULL', true);
});

bot.action('backtest_regime_chop', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Choppy...');
  await runAndSendBacktest(ctx, 'CHOP', true);
});

bot.action('backtest_regime_bloodbath', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Bloodbath...');
  await runAndSendBacktest(ctx, 'BLOODBATH', true);
});

bot.action('backtest_regime_pumpdump', async (ctx) => {
  await ctx.answerCbQuery('Memulai skenario Pump & Dump...');
  await runAndSendBacktest(ctx, 'PUMP_DUMP', true);
});

function formatNumber(num: number): string {
  if (!num) return '0';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(2) + 'K';
  return num.toFixed(2);
}

import { scoutTrendingWhales, getOrganicTrendingTokens } from '../src/services/whaleScout';
import { getAllWhales, getWhaleQueue } from '../src/db/index';

async function main() {
  console.log('--- 1. MENGECEK 16 POOL ORGANIK TRENDING SOLANA TERKINI ---');
  const pools = await getOrganicTrendingTokens(16);
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    console.log(`[${i + 1}] ${p.poolName} | 24h Vol: $${(p.volumeUsd / 1_000_000).toFixed(2)}M | CA: ${p.tokenMint}`);
  }

  console.log('\n--- 2. MEMULAI PEMINDAIAN SMART MONEY ORGANIK (TARGET: 4 PAUS) ---');
  const beforeCount = getAllWhales().length;
  const beforeQueue = getWhaleQueue().length;
  
  const result = await scoutTrendingWhales(4);
  
  console.log('\n--- 3. HASIL PEMINDAIAN WHALE SCOUT ---');
  console.log({
    direkrutAktif: result.recruited,
    masukQueue: result.queued,
    totalWhalesSekarang: result.totalWhales,
    totalQueueSekarang: result.queueLength
  });

  console.log('\n--- 4. DAFTAR PAUS AKTIF DI RADAR SAAT INI ---');
  const whales = getAllWhales();
  for (const w of whales) {
    console.log(`- [ID ${w.id}] [${w.tier || 'PROBATION'}] ${w.label} | Saldo Copy: ${w.auto_copy ? 'ON' : 'OFF'} | Alamat: ${w.address}`);
  }

  console.log('\n--- 5. DAFTAR TOP KANDIDAT DI SHADOW QUEUE (CADANGAN) ---');
  const queue = getWhaleQueue(5);
  for (const q of queue) {
    console.log(`- [Queue #${q.id}] ${q.label} | Arketipe: ${q.archetype} | Saldo: ${q.balance_sol.toFixed(2)} SOL | Pool: ${q.reference_pool} | Alamat: ${q.address}`);
  }

  console.log('\n✅ Pemindaian selesai! Menutup koneksi on-chain...');
  process.exit(0);
}

main().catch(err => {
  console.error('Error during manual scout:', err);
  process.exit(1);
});

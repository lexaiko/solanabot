import { 
  initDatabase, 
  removeWhale, 
  addWhale, 
  getAllWhales, 
  getWhaleByAddress 
} from '../src/db/index';
import { refreshWhaleSubscriptions } from '../src/services/tracker';
import { scoutTrendingWhales } from '../src/services/whaleScout';

async function executePurgeAndReplenish() {
  console.log('🧹 ========================================================');
  console.log('🧹 EKSEKUSI PEMBERSIHAN RADAR & TRANSISI KE PRO-ORGANIK');
  console.log('🧹 ========================================================\n');

  initDatabase();

  const toPurge = [
    { id: 4, label: 'Paus Sniper Alpha (0.01 SOL, Dead)' },
    { id: 5, label: 'Solana Smart Momentum (0.00 SOL, Dead)' },
    { id: 6, label: 'Raydium Volume Hunter (0.03 SOL, Dead)' },
    { id: 7, label: 'Pump.fun Gem Finder (0.01 SOL, Dead)' },
    { id: 10, label: 'Scout: $ape Smart Buyer (0.01 SOL, MEV)' },
    { id: 11, label: 'Scout: $UTC Smart Buyer (72% Error, Spam Sniper)' },
    { id: 15, label: 'Scout: $STONK Smart Buyer (0.59 SOL, Flipper)' }
  ];

  console.log('1. Mengeliminasi 7 dompet berkinerja buruk / bot MEV...');
  for (const p of toPurge) {
    const success = removeWhale(p.id);
    console.log(`  🗑️ Dieliminasi #${p.id} [${p.label}]: ${success ? 'SUKSES' : 'TIDAK DITEMUKAN'}`);
  }

  console.log('\n2. Memasukkan Paus Pro Hasil Audit Organik On-Chain...');
  
  // 1. VIP Whale 41.62 SOL
  const vipWhale = 'GmdbWjNv1Wgu1GeTRhrLpSx25aTpNCs4cpjbkcnzPmHp';
  if (!getWhaleByAddress(vipWhale)) {
    addWhale(vipWhale, '👑 Paus: $Nasduck VIP Accumulator', 0.15, 0, 'VIP');
    console.log(`  ✅ Ditambahkan: 👑 Paus: $Nasduck VIP Accumulator (Saldo: 41.62 SOL)`);
  }

  // 2. Smart Buyer 1.75 SOL
  const smartBuyer = 'B3ePg452uQVf5FjkMavPTnshxGyCmUrYFo9sL5ejvygp';
  if (!getWhaleByAddress(smartBuyer)) {
    addWhale(smartBuyer, '⚡ Smart: $ZCAT Momentum Whale', 0.1, 0, 'PROBATION');
    console.log(`  ✅ Ditambahkan: ⚡ Smart: $ZCAT Momentum Whale (Saldo: 1.75 SOL)`);
  }

  console.log('\n3. Memperbarui Pipa WebSocket Solana RPC...');
  refreshWhaleSubscriptions();

  console.log('\n4. Menjalankan Pemindaian Tambahan Organik untuk Mengisi Slot...');
  const scoutResult = await scoutTrendingWhales(3);
  console.log(`  Scout Result: Recruited ${scoutResult.recruited} active, Queued ${scoutResult.queued} candidates.`);

  const currentWhales = getAllWhales();
  console.log(`\n🎉 SELESAI! Radar aktif saat ini memegang ${currentWhales.length} paus murni berstandar institusional:\n`);
  currentWhales.forEach(w => {
    console.log(`• #${w.id} [${w.tier}] ${w.label} (\`${w.address}\`) - Mode: ${w.auto_copy ? 'AUTO-COPY' : 'SHADOW'}`);
  });
}

executePurgeAndReplenish().catch(console.error);

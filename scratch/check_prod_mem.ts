import { db } from '../src/db/index';
import { calculateKellyPositionSize } from '../src/services/kellyEngine';
import { getSolPriceUsd } from '../src/services/dexscreener';

const mem = process.memoryUsage();
console.log('=== MEMORY CONSUMPTION (STANDALONE RUNTIME) ===');
console.log('RSS (Resident Set Size / Physical RAM):', (mem.rss / 1024 / 1024).toFixed(2), 'MB');
console.log('Heap Total:', (mem.heapTotal / 1024 / 1024).toFixed(2), 'MB');
console.log('Heap Used:', (mem.heapUsed / 1024 / 1024).toFixed(2), 'MB');
console.log('External:', (mem.external / 1024 / 1024).toFixed(2), 'MB');

process.exit(0);

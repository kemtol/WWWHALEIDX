/**
 * Pindahkan payload LT dari `logs/frames.jsonl` ke arsip harian `logs/lt/`.
 *
 * Alat pemulihan, bukan bagian dari alur normal: sejak frame LT tidak lagi dicatat
 * ke frames.jsonl (lihat ipot.ts), scanner mengarsip sendiri. Skrip ini dipakai
 * untuk menyelamatkan data yang sudah ada di frames.jsonl sebelum perubahan itu,
 * atau kalau suatu saat arsip perlu dibangun ulang dari frame log.
 *
 * Aman dijalankan berulang? TIDAK — ia meng-append. Cek dulu isi logs/lt/.
 *
 *   npx tsx tools/backfill-lt.ts
 */
import { createReadStream, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wibDateStr } from '../src/archive.js';
import { parseTrade } from '../src/ipot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'logs', 'frames.jsonl');
const DEST_DIR = join(ROOT, 'logs', 'lt');

if (!existsSync(SRC)) {
  console.error(`tidak ada ${SRC}`);
  process.exit(1);
}
mkdirSync(DEST_DIR, { recursive: true });

const buckets = new Map<string, string[]>();
let lines = 0, trades = 0, skipped = 0;

const rl = createInterface({ input: createReadStream(SRC), crlfDelay: Infinity });
for await (const line of rl) {
  lines++;
  // Frame aslinya tersimpan sebagai STRING di dalam JSONL, jadi tanda kutipnya
  // ter-escape: yang muncul di baris adalah \"rtype\":\"LT\", bukan "rtype":"LT".
  if (!line || line.indexOf('\\"rtype\\":\\"LT\\"') === -1) continue;
  let o: any;
  try { o = JSON.parse(line); } catch { skipped++; continue; }
  const payload = o?.data && JSON.parse(o.data)?.data?.data;
  if (typeof payload !== 'string' || !parseTrade(payload)) { skipped++; continue; }
  // Tanggal diambil dari waktu terima frame, bukan jam bursa di payload —
  // payload hanya punya HHMMSS, tanpa tanggal.
  const date = wibDateStr(new Date(o.t));
  let b = buckets.get(date);
  if (!b) { b = []; buckets.set(date, b); }
  b.push(payload);
  trades++;
}

for (const [date, rows] of [...buckets].sort()) {
  const path = join(DEST_DIR, `${date}.txt`);
  appendFileSync(path, rows.join('\n') + '\n');
  console.log(`${date}: +${rows.length} transaksi → ${path}`);
}
console.log(`\n${lines} baris dibaca · ${trades} transaksi diarsipkan · ${skipped} dilewati`);

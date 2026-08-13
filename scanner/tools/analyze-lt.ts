/**
 * Bedah field feed LT dari arsip satu hari.
 *
 *   npx tsx tools/analyze-lt.ts 2026-08-14
 *
 * Dua sasaran:
 *
 * 1. Mengunci ulang [17] = VWAP. Kalau arsipnya dimulai dari pembukaan, tidak ada
 *    volume yang terlewat, jadi VWAP bisa dihitung sendiri dari nol dan dibandingkan
 *    langsung — tanpa parameter bebas seperti waktu diuji dari log setengah hari.
 *
 * 2. Mencari arti angka ~7 digit di [13]/[14]. Yang sudah diketahui: selalu tepat satu
 *    dari dua slot itu berisi angka (slot lainnya "00"), dan slot yang dipakai berpindah
 *    bahkan untuk emiten yang sama. Deltanya bukan lot dan bukan lembar. Skrip ini
 *    menguji sederet hipotesis sekaligus supaya yang tidak cocok cepat tersingkir.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('pakai: npx tsx tools/analyze-lt.ts YYYY-MM-DD');
  process.exit(1);
}

const path = join(ROOT, 'logs', 'lt', `${date}.txt`);
let rows: string[][];
try {
  rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => l.split('|'));
} catch {
  console.error(`tidak bisa membaca ${path}`);
  process.exit(1);
}

const F = (r: string[], i: number) => Number(r[i]);
const pct = (a: number, b: number) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`);
const head = (s: string) => console.log(`\n${'═'.repeat(72)}\n  ${s}\n${'═'.repeat(72)}`);

console.log(`arsip ${date}: ${rows.length.toLocaleString('id-ID')} transaksi`);
console.log(`jam    : ${rows[0][1]} → ${rows[rows.length - 1][1]}`);
const boards = new Map<string, number>();
for (const r of rows) boards.set(r[4], (boards.get(r[4]) ?? 0) + 1);
console.log(`papan  : ${[...boards].map(([b, n]) => `${b} ${n}`).join(' · ')}`);
console.log(`emiten : ${new Set(rows.map((r) => r[3])).size}`);

// Apakah arsipnya benar-benar mulai dari pembukaan? Kalau tidak, uji VWAP di bawah
// akan gagal bukan karena hipotesisnya salah, tapi karena volume awal tidak terlihat.
const startsAtOpen = rows[0][1] <= '090100';
if (!startsAtOpen) {
  console.log(`\n  ⚠ transaksi pertama jam ${rows[0][1]}, bukan ~090000 — arsip TIDAK utuh`);
  console.log('    uji VWAP di bawah akan meleset karena volume sebelum itu tidak terlihat.');
}

// ── 1. [17] = VWAP? ─────────────────────────────────────────────────────────
head('[17] = VWAP kumulatif (per emiten + papan)');

// Dikelompokkan per emiten+papan: sudah terbukti feed memisahkan VWAP tiap papan
// (GOTO pernah 33 di NG sementara 50 di RG).
const acc = new Map<string, { pq: number; q: number }>();
let checked = 0, exact = 0, within1 = 0, worst = 0, worstAt = '';
for (const r of rows) {
  const key = `${r[3]}|${r[4]}`;
  let a = acc.get(key);
  if (!a) { a = { pq: 0, q: 0 }; acc.set(key, a); }
  const price = F(r, 6), lot = F(r, 7), avg = F(r, 17);
  if (!Number.isFinite(price) || !Number.isFinite(lot)) continue;
  a.pq += price * lot;
  a.q += lot;
  if (!(avg > 0) || a.q === 0) continue;
  const mine = a.pq / a.q;
  const err = Math.abs(mine - avg);
  checked++;
  if (Math.round(mine) === avg) exact++;
  if (err <= 1) within1++;
  if (err > worst) { worst = err; worstAt = `${key} jam ${r[1]} (feed ${avg}, hitungan ${mine.toFixed(2)})`; }
}
console.log(`dibandingkan   : ${checked.toLocaleString('id-ID')} transaksi`);
console.log(`bulat sama     : ${exact.toLocaleString('id-ID')} (${pct(exact, checked)})`);
console.log(`selisih ≤ Rp 1 : ${within1.toLocaleString('id-ID')} (${pct(within1, checked)})`);
console.log(`selisih terburuk: ${worst.toFixed(2)} pada ${worstAt}`);
console.log(startsAtOpen
  ? '\n→ kalau "selisih ≤ Rp 1" mendekati 100%, [17] = VWAP sudah pasti.'
  : '\n→ arsip tidak utuh; angka di atas hanya indikasi.');

// ── 2. Angka ~7 digit di [13]/[14] ──────────────────────────────────────────
head('[13]/[14] — angka ~7 digit yang berpindah slot');

const bigOf = (r: string[]) => {
  const a = r[13], b = r[14];
  const aNum = a !== '00' && a !== '' && Number.isFinite(Number(a));
  const bNum = b !== '00' && b !== '' && Number.isFinite(Number(b));
  if (aNum && !bNum) return { slot: 13, v: Number(a) };
  if (bNum && !aNum) return { slot: 14, v: Number(b) };
  if (aNum && bNum) return { slot: 0, v: NaN };      // dua-duanya berisi: bentuk baru
  return { slot: -1, v: NaN };                        // dua-duanya "00"
};

let both = 0, neither = 0, s13 = 0, s14 = 0;
for (const r of rows) {
  const b = bigOf(r);
  if (b.slot === 13) s13++;
  else if (b.slot === 14) s14++;
  else if (b.slot === 0) both++;
  else neither++;
}
console.log(`di [13]: ${s13} · di [14]: ${s14} · dua-duanya berisi: ${both} · dua-duanya "00": ${neither}`);

// Apakah pilihan slot bisa dijelaskan sesuatu? Uji korelasi dengan atribut yang ada.
const seen = new Set<string>();
const tally = new Map<string, [number, number]>();   // label -> [pakai 13, pakai 14]
const bump = (label: string, slot: number) => {
  const t = tally.get(label) ?? [0, 0];
  t[slot === 13 ? 0 : 1]++;
  tally.set(label, t);
};
for (const r of rows) {
  const b = bigOf(r);
  if (b.slot !== 13 && b.slot !== 14) continue;
  const key = `${r[3]}|${r[4]}`;
  bump(`papan ${r[4]}`, b.slot);
  bump(seen.has(key) ? 'transaksi ke-2+ emiten' : 'transaksi PERTAMA emiten', b.slot);
  bump(F(r, 16) === 0 ? 'tick = 0' : 'tick ≠ 0', b.slot);
  bump(F(r, 15) === 0 ? 'harga = penutupan kemarin' : 'harga ≠ penutupan kemarin', b.slot);
  seen.add(key);
}
console.log('\npilihan slot menurut atribut (kalau ada baris yang 100%/0%, itu penjelasnya):');
for (const [label, [a, b]] of [...tally].sort()) {
  const tot = a + b;
  console.log(`  ${label.padEnd(32)} [13] ${String(a).padStart(7)} (${pct(a, tot).padStart(6)})  [14] ${String(b).padStart(7)}`);
}

// Hipotesis isi angkanya. Semua diuji sebagai "kumulatif per emiten+papan":
// nilai pada transaksi ke-n harus sama dengan akumulasi kita sampai transaksi itu.
head('isi angka itu — hipotesis kumulatif per emiten+papan');
const hyp: Record<string, (a: { lot: number; lembar: number; value: number; n: number }, r: string[]) => number> = {
  'volume (lot)':        (a) => a.lot,
  'volume (lembar)':     (a) => a.lembar,
  'nilai (rupiah)':      (a) => a.value,
  'nilai (ribu rupiah)': (a) => Math.floor(a.value / 1_000),
  'nilai (juta rupiah)': (a) => Math.floor(a.value / 1_000_000),
  'frekuensi':           (a) => a.n,
};
const state = new Map<string, { lot: number; lembar: number; value: number; n: number }>();
const score = new Map<string, number>(Object.keys(hyp).map((k) => [k, 0]));
let tested = 0;
for (const r of rows) {
  const b = bigOf(r);
  const key = `${r[3]}|${r[4]}`;
  let a = state.get(key);
  if (!a) { a = { lot: 0, lembar: 0, value: 0, n: 0 }; state.set(key, a); }
  a.lot += F(r, 7);
  a.lembar += F(r, 7) * 100;
  a.value += F(r, 6) * F(r, 7) * 100;
  a.n += 1;
  if (b.slot !== 13 && b.slot !== 14) continue;
  tested++;
  for (const [name, fn] of Object.entries(hyp)) {
    if (fn(a, r) === b.v) score.set(name, score.get(name)! + 1);
  }
}
console.log(`diuji pada ${tested.toLocaleString('id-ID')} transaksi yang punya angka itu:\n`);
for (const [name, n] of [...score].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${name.padEnd(22)} cocok ${String(n).padStart(7)} (${pct(n, tested)})`);
}

// Kumulatif tingkat pasar, bukan per emiten — diuji terpisah karena tidak butuh key.
head('isi angka itu — hipotesis kumulatif seluruh pasar');
let mLot = 0, mLembar = 0, mValue = 0, mN = 0;
const mScore = { 'volume pasar (lot)': 0, 'volume pasar (lembar)': 0, 'nilai pasar (juta)': 0, 'frekuensi pasar': 0 };
for (const r of rows) {
  mLot += F(r, 7); mLembar += F(r, 7) * 100; mValue += F(r, 6) * F(r, 7) * 100; mN += 1;
  const b = bigOf(r);
  if (b.slot !== 13 && b.slot !== 14) continue;
  if (b.v === mLot) mScore['volume pasar (lot)']++;
  if (b.v === mLembar) mScore['volume pasar (lembar)']++;
  if (b.v === Math.floor(mValue / 1e6)) mScore['nilai pasar (juta)']++;
  if (b.v === mN) mScore['frekuensi pasar']++;
}
for (const [name, n] of Object.entries(mScore).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${name.padEnd(22)} cocok ${String(n).padStart(7)} (${pct(n, tested)})`);
}

// Kalau semua hipotesis di atas nol, cetak bahan mentah supaya bisa dilihat manual.
head('bahan mentah — deret angka pada satu emiten teraktif');
const count = new Map<string, number>();
for (const r of rows) if (r[4] === 'RG') count.set(r[3], (count.get(r[3]) ?? 0) + 1);
const top = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
console.log(`emiten: ${top}\n`);
console.log('  jam      harga    lot     [13]      [14]     selisih-vs-sebelumnya');
let prev = NaN;
let shown = 0;
for (const r of rows) {
  if (r[3] !== top || r[4] !== 'RG' || shown >= 25) continue;
  const b = bigOf(r);
  const d = Number.isFinite(prev) && Number.isFinite(b.v) ? b.v - prev : NaN;
  console.log(`  ${r[1]}  ${r[6].padStart(7)} ${r[7].padStart(6)}  ${r[13].padStart(8)}  ${r[14].padStart(8)}  ${Number.isFinite(d) ? String(d).padStart(10) : ''}`);
  if (Number.isFinite(b.v)) prev = b.v;
  shown++;
}
console.log('');

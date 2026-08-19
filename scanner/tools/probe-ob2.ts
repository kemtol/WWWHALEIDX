import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAppSession } from '../src/ipot.js';

/**
 * Ukur biaya OB2 sebelum memutuskan membangunnya.
 *
 * Membuka koneksi KEDUA memakai token sesi milik collector — seperti membuka tab kedua,
 * jadi collector tidak perlu direstart dan sesinya tidak diputus. Kalau IPOT ternyata
 * hanya mengizinkan satu sesi, ini bisa menendang collector; itu risiko yang disengaja
 * dan biayanya satu scan QR.
 *
 * Yang diukur: pesan/detik, byte/menit, dan bentuk datanya. Angka inilah yang menentukan
 * roster OB2 boleh 108 emiten atau harus 30.
 *
 *   npx tsx tools/probe-ob2.ts INET KIJA BBCA [detik]
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WS_URL = 'wss://ipotapp.ipot.id/socketcluster/';
const ORIGIN = 'https://indopremier.com';

const args = process.argv.slice(2);
const durasi = Number(args.find((a) => /^\d+$/.test(a)) ?? 60);
const simbol = args.filter((a) => /^[A-Z]{2,6}$/.test(a));
if (!simbol.length) { console.error('sebutkan minimal satu kode emiten'); process.exit(1); }

const token = JSON.parse(readFileSync(join(ROOT, 'logs', 'session.json'), 'utf8'))?.authToken;
if (!token) { console.error('tidak ada token sesi tersimpan — collector belum login'); process.exit(1); }

const hitung = new Map<string, { n: number; byte: number }>();
let lain = 0, lt = 0, contoh: string | null = null;
let cid = 0;

const ws = new WebSocket(`${WS_URL}?appsession=${await fetchAppSession()}`, {
  headers: { Origin: ORIGIN, 'User-Agent': 'Mozilla/5.0' },
});

ws.on('open', () => {
  ws.send(JSON.stringify({ event: '#handshake', data: { authToken: token }, cid: ++cid }));
});

let mulai = 0;
ws.on('message', (buf) => {
  const raw = buf.toString();
  if (raw === '#1') { ws.send('#2'); return; }

  let m: any;
  try { m = JSON.parse(raw); } catch { return; }

  // Balasan handshake
  if (m.rid === 1) {
    const ok = m?.data?.isAuthenticated === true;
    console.log(`  handshake: isAuthenticated=${ok}`);
    if (!ok) {
      console.log('  token ditolak — OB2 tidak bisa diuji lewat jalur ini.');
      ws.close(); return;
    }
    console.log(`  langganan OB2: ${simbol.join(' ')} (level 10) selama ${durasi} detik…\n`);
    for (const code of simbol) {
      ws.send(JSON.stringify({
        event: 'cmd',
        data: { cmdid: ++cid, param: {
          cmd: 'subscribe', service: 'mi', rtype: 'OB2', code, level: 10,
          subsid: `probe_${code}`,
        } },
        cid: ++cid,
      }));
    }
    mulai = Date.now();
    setTimeout(selesai, durasi * 1000);
    return;
  }

  if (m?.error) { console.log('  ERROR dari server:', JSON.stringify(m.error)); return; }

  const rtype = m?.data?.rtype;
  if (rtype === 'OB2') {
    const code = m?.data?.code ?? '?';
    const c = hitung.get(code) ?? { n: 0, byte: 0 };
    c.n++; c.byte += raw.length;
    hitung.set(code, c);
    if (!contoh) contoh = raw;
  } else if (rtype === 'LT') lt++;
  else lain++;
});

ws.on('error', (e) => { console.error('  gagal:', e.message); process.exit(1); });

function selesai() {
  const dtk = (Date.now() - mulai) / 1000;
  let n = 0, byte = 0;
  console.log('  emiten     pesan   pesan/dtk    KB      KB/menit');
  for (const [code, c] of [...hitung].sort((a, b) => b[1].n - a[1].n)) {
    n += c.n; byte += c.byte;
    console.log(`  ${code.padEnd(8)} ${String(c.n).padStart(7)} ${(c.n / dtk).toFixed(1).padStart(11)}`
      + `${(c.byte / 1024).toFixed(0).padStart(8)} ${(c.byte / 1024 / dtk * 60).toFixed(0).padStart(13)}`);
  }
  console.log(`\n  TOTAL ${simbol.length} emiten · ${dtk.toFixed(0)} dtk`);
  console.log(`    ${n} pesan · ${(n / dtk).toFixed(1)}/dtk · ${(byte / 1024).toFixed(0)} KB`
    + ` · ${(byte / 1024 / dtk * 60).toFixed(0)} KB/menit`);
  const perEmiten = byte / 1024 / dtk * 60 / simbol.length;
  console.log(`    per emiten: ${perEmiten.toFixed(0)} KB/menit`
    + ` → 108 emiten ≈ ${(perEmiten * 108 * 330 / 1024).toFixed(0)} MB/hari bursa`);
  console.log(`    pembanding: seluruh feed LT = 0,23 MB/menit (~77 MB/hari)`);
  if (lt || lain) console.log(`    (frame lain: ${lt} LT, ${lain} non-OB2)`);
  if (contoh) console.log(`\n  contoh frame OB2:\n${contoh.slice(0, 700)}`);
  ws.close();
  process.exit(0);
}

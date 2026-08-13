import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IpotClient, marketLikelyOpen } from './ipot.js';
import { UiServer } from './server.js';
import { Scanner, DEFAULT_FILTER } from './filters.js';
import { TradeArchive, wibDateStr } from './archive.js';
import { queryHistory } from './history.js';
import { desktopNotify } from './notify.js';
import { SymbolTracker } from './symbol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** TLS_CERT/TLS_KEY diisi (lihat systemd unit) -> jalan HTTPS di HTTPS_PORT (domain lokal,
 *  mis. whale.scanner.local). Tanpa keduanya -> tetap HTTP biasa di PORT, seperti semula. */
const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
  : undefined;
const PORT = Number(tls ? (process.env.HTTPS_PORT ?? 443) : (process.env.PORT ?? 3000));

const ui = new UiServer(join(ROOT, 'public'), tls);
const URL_BASE = tls ? `https://${process.env.APP_HOST ?? '127.0.0.1'}` : `http://127.0.0.1:${PORT}`;
const ipot = new IpotClient(join(ROOT, 'logs'));
const scanner = new Scanner({ ...DEFAULT_FILTER });
/** Arsip harian semua transaksi, apa pun filternya — dasar untuk melihat mundur
 *  dan untuk membedah field yang artinya belum ketahuan. ARCHIVE_DAYS mengatur retensi. */
const archive = new TradeArchive(join(ROOT, 'logs'), Number(process.env.ARCHIVE_DAYS ?? 30));

/** Transaksi lolos filter yang terakhir, supaya tab yang baru dibuka tidak melihat
 *  tabel kosong. Sengaja hanya di memori: yang tahan restart adalah arsip di atas. */
const BACKLOG_MAX = 200;
let backlog: unknown[] = [];

/** Pembacaan order flow per emiten (delta, footprint) untuk emiten yang dibuka
 *  di panel detail. Hanya emiten yang diminta — pola yang sama akan dipakai OB2. */
const tracker = new SymbolTracker();

const log = (msg: string) => console.log(`  ${msg}`);
const hr = () => console.log('─'.repeat(64));

let qrTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

ipot.on('status', (m) => { log(m); ui.setState({ status: m }); });

ipot.on('qr', async (info) => {
  let svg: string | null = null;
  try {
    svg = await QRCode.toString(info.qrcode, { type: 'svg', margin: 1, width: 320 });
  } catch (e) {
    log(`gagal render QR: ${(e as Error).message}`);
  }

  ui.setState({ phase: 'menunggu scan', qrSvg: svg, qrExpiresAt: Date.now() + info.span * 1000 });

  if (ui.clientCount === 0) {
    hr();
    console.log(`  Belum ada tab terbuka — QR dicetak di sini (berlaku ${info.span} detik).`);
    console.log(`  Lebih enak: buka ${URL_BASE}\n`);
    qrcodeTerminal.generate(info.qrcode, { small: true });
    hr();
  } else {
    log(`QR dikirim ke halaman (berlaku ${info.span} detik)`);
  }

  if (qrTimer) clearTimeout(qrTimer);
  qrTimer = setTimeout(() => {
    if (!ipot.loggedIn) {
      log('QR kedaluwarsa.');
      ui.setState({ phase: 'QR kedaluwarsa', qrSvg: null });
    }
  }, info.span * 1000);
});

ipot.on('login', () => {
  if (qrTimer) clearTimeout(qrTimer);
  log('login berhasil');
  ui.setState({ phase: 'login berhasil', qrSvg: null, loggedIn: true });
  ipot.subscribeLiveTrade();
});

let lastStats = 0;
ipot.on('trade', (t) => {
  // Diarsipkan sebelum disaring: filter berubah sepanjang hari, arsip tidak boleh ikut.
  archive.write(t.raw);
  // Panel detail juga harus melihat SEMUA transaksi emitennya, bukan yang lolos filter —
  // footprint dan delta jadi salah kalau hanya menghitung transaksi besar.
  tracker.feed(t, wibDateStr());
  const { pass, burst, count } = scanner.evaluate(t);
  if (pass) {
    const msg = { type: 'trade', trade: t, burst, count };
    ui.broadcast(msg);
    backlog.push(msg);
    if (backlog.length > BACKLOG_MAX) backlog.shift();
  }
  if (Date.now() - lastStats > 1000) {
    lastStats = Date.now();
    ui.setState({ stats: scanner.stats });
  }
});

ui.getBacklog = () => backlog;

ui.onApi = (path, q) => {
  if (path === '/api/days') {
    return archive.days().map((d) => ({ date: d, bytes: archive.sizeOf(d) }));
  }
  // Panel detail per emiten. `watch` sekali saat dibuka (mengisi dari arsip supaya
  // lengkap sejak pembukaan), lalu halaman menarik `detail` berkala untuk yang live.
  if (path === '/api/symbol') {
    const code = (q.get('code') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(code)) return { error: 'kode emiten tidak sah' };
    const date = q.get('date') || wibDateStr();
    if (q.get('reload') === '1' || !tracker.isWatching(code, date)) {
      tracker.backfill(code, date, archive.readDay(date));
    }
    return { date, live: date === wibDateStr(), detail: tracker.detail(code) };
  }
  if (path === '/api/unwatch') {
    const code = (q.get('code') ?? '').trim().toUpperCase();
    tracker.unwatch(code);
    return { ok: true, watching: tracker.watching() };
  }
  if (path === '/api/history') {
    const list = (k: string) =>
      (q.get(k) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const num = (k: string) => {
      const v = Number(q.get(k));
      return Number.isFinite(v) ? v : undefined;
    };
    return queryHistory(archive, {
      date: q.get('date') || wibDateStr(),
      from: q.get('from'),
      to: q.get('to'),
      symbols: list('symbols'),
      boards: list('boards'),
      minValue: num('minValue'),
      limit: num('limit'),
    });
  }
  return null;
};

// Peringkat tekanan HAKA/HAKI — agregat, jadi cukup 2 detik sekali.
setInterval(() => {
  if (ui.clientCount === 0) return;
  const top = scanner.pressureTop(15);
  if (top.length) {
    ui.setState({ pressure: top, pressureWindowSec: scanner.config.pressureWindowSec });
  }
}, 2000);

/** Bursa buka tapi scanner tidak login = tidak ada `subscribe LT`, jadi tidak ada
 *  transaksi yang terekam — dan sebelum ini, tidak ada tanda apa pun bahwa itu terjadi.
 *  Pada 13 Agu 2026 scanner restart 08:35, tersambung normal, menerima notifikasi IDX
 *  seperti biasa, tapi tidak ada yang scan QR: 1,5 jam pertama sesi 1 hilang begitu saja.
 *
 *  Tenggang 2 menit supaya restart singkat atau reconnect biasa tidak ikut menjerit.
 *  Setelah itu diingatkan berkala — cukup jarang untuk tidak mengganggu, cukup sering
 *  untuk tidak terlewat satu sesi penuh. */
const GRACE_MS = 120_000;
const NAG_MS = 10 * 60_000;
let notLoggedSince: number | null = null;
let lastNag = 0;

setInterval(() => {
  const open = marketLikelyOpen();

  if (!open || ipot.loggedIn) {
    // Baru saja login setelah sempat tertinggal: catat berapa lama yang hilang,
    // supaya jejaknya ada di journal walau notifikasinya sudah lewat.
    if (notLoggedSince !== null && ipot.loggedIn) {
      const lost = Math.round((Date.now() - notLoggedSince) / 60_000);
      if (lost >= 2) log(`login setelah ${lost} menit tidak terekam saat bursa buka`);
    }
    notLoggedSince = null;
    lastNag = 0;
    ui.setState({ notLoggedMins: 0 });
    return;
  }

  if (notLoggedSince === null) notLoggedSince = Date.now();
  const elapsed = Date.now() - notLoggedSince;
  if (elapsed < GRACE_MS) return;

  const mins = Math.round(elapsed / 60_000);
  ui.setState({ notLoggedMins: mins });

  if (Date.now() - lastNag < NAG_MS) return;
  lastNag = Date.now();
  hr();
  console.log(`  ⚠ BURSA BUKA TAPI BELUM LOGIN — ${mins} menit transaksi TIDAK terekam.`);
  console.log(`     Buka ${URL_BASE} lalu scan QR.`);
  hr();
  desktopNotify(
    'Whale Scanner belum login',
    `Bursa buka, ${mins} menit transaksi tidak terekam. Buka ${URL_BASE} dan scan QR.`,
    true,
  );
}, 30_000);

let unknownCount = 0;
ipot.on('unknown', (m) => {
  unknownCount++;
  if (unknownCount <= 15) {
    console.log(`  [?] ${typeof m === 'string' ? m.slice(0, 300) : JSON.stringify(m).slice(0, 300)}`);
  }
});

/** Koneksi putus atau dianggap mati oleh watchdog — sambung ulang dengan backoff. */
ipot.on('closed', (why) => {
  log(`koneksi IPOT ${why}`);
  const delay = Math.min(30_000, 2_000 * 2 ** reconnectAttempt);
  reconnectAttempt++;
  ui.setState({
    phase: `terputus (${why}) — menyambung ulang dalam ${Math.round(delay / 1000)} detik`,
    loggedIn: false,
  });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { void startSession(); }, delay);
});

/** Satu siklus koneksi: handshake, lalu subscribe kalau sesi tersimpan masih sah. */
async function startSession() {
  try {
    const authenticated = await ipot.connect();
    reconnectAttempt = 0;

    if (authenticated) {
      log('sesi dipulihkan dari token tersimpan — tidak perlu scan ulang');
      ui.setState({ phase: 'sesi dipulihkan', loggedIn: true, qrSvg: null });
      ipot.subscribeLiveTrade();
    } else {
      if (ipot.hasSavedSession()) {
        log('token tersimpan sudah tidak berlaku — perlu scan QR lagi');
        ipot.clearSession();
      }
      ui.setState({ phase: 'siap login', loggedIn: false });
      console.log(`\n  Buka  →  ${URL_BASE}  lalu klik "Tampilkan QR"\n`);
    }
    ipot.startWatchdog();
  } catch (e) {
    const delay = Math.min(30_000, 2_000 * 2 ** reconnectAttempt);
    reconnectAttempt++;
    log(`gagal menyambung: ${(e as Error).message} — coba lagi ${Math.round(delay / 1000)} detik`);
    ui.setState({ phase: `gagal menyambung, mencoba lagi…`, loggedIn: false });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { void startSession(); }, delay);
  }
}

ui.onCommand = (msg) => {
  if (msg.cmd === 'login') { log('permintaan QR dari halaman...'); ipot.requestQrLogin(); }
  if (msg.cmd === 'subscribe') { log('subscribe manual dari halaman...'); ipot.subscribeLiveTrade(); }
  if (msg.cmd === 'logout') {
    log('logout diminta dari halaman');
    ipot.clearSession();
    ipot.loggedIn = false;
    scanner.resetStats();
    backlog = [];
    ui.setState({ phase: 'keluar…', loggedIn: false, qrSvg: null, stats: scanner.stats });
    // Tutup socket lalu sambung ulang bersih; tanpa token, server akan menolak
    // autentikasi dan halaman kembali ke layar QR.
    ipot.close();
    setTimeout(() => { void startSession(); }, 400);
  }
  // Jendela tekanan diubah terpisah dari filter supaya statistik tidak ikut ter-reset.
  if (msg.cmd === 'pressureWindow' && typeof msg.sec === 'number') {
    scanner.update({ pressureWindowSec: msg.sec });
    log(`jendela tekanan: ${msg.sec} detik`);
    ui.setState({ filter: scanner.config, pressureWindowSec: msg.sec });
  }
  if (msg.cmd === 'filter' && msg.config) {
    scanner.update(msg.config as never);
    scanner.resetStats();
    // Backlog berisi transaksi yang lolos filter LAMA — halaman juga mengosongkan
    // tabelnya saat filter diterapkan, jadi jangan sampai tab lain menyajikannya lagi.
    backlog = [];
    log(`filter diperbarui: minValue=${scanner.config.minValue} watchlist=${scanner.config.watchlist.length || 'semua'}`);
    ui.setState({ filter: scanner.config, stats: scanner.stats });
  }
};

/** Keluar rapi: arsip menumpuk transaksi di memori sampai flush berikutnya, dan
 *  systemd me-restart service ini kapan saja — tanpa flush di sini, beberapa detik
 *  transaksi terakhir hilang dari arsip setiap restart. */
function shutdown(code: number): never {
  archive.flush();
  process.exit(code);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

function setupKeys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === '' || key === 'q') { console.log('\n  keluar.'); shutdown(0); }
    if (key === 'r') { log('minta QR...'); ipot.requestQrLogin(); }
    if (key === 's') { log('subscribe manual...'); ipot.subscribeLiveTrade(); }
  });
}

async function main() {
  hr();
  console.log('  WHALE SCANNER — running trade + filter');
  console.log(`  bursa saat ini: ${marketLikelyOpen() ? 'BUKA' : 'tutup'}`);
  hr();

  await ui.listen(PORT);
  log(`UI di ${URL_BASE}`);
  ui.setState({ filter: scanner.config, stats: scanner.stats });

  await startSession();
  setupKeys();
  console.log('  Cadangan terminal: [r] QR  [s] subscribe  [q] keluar\n');
}

main().catch((err) => {
  console.error('  GAGAL:', err.message);
  process.exit(1);
});

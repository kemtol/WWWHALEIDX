import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import { IpotClient, marketLikelyOpen, marketPreOpening } from './ipot.js';
import { TradeArchive, wibDateStr } from './archive.js';
import { desktopNotify } from './notify.js';
import { BusServer, SOCKET_PATH } from './bus.js';

/**
 * Collector — satu-satunya proses yang menyentuh IPOT.
 *
 * Tugasnya sengaja dibuat sesempit mungkin: sambung, login, subscribe, tulis arsip,
 * teruskan ke app. Tidak ada filter, tidak ada UI, tidak ada analitik — supaya kodenya
 * hampir tidak pernah perlu diubah, dan karena itu hampir tidak pernah perlu direstart.
 *
 * Kenapa itu penting: IPOT menolak token sesi yang dipulihkan (`#removeAuthToken`), jadi
 * setiap restart menuntut scan QR ulang. Selama koneksi hidup bersama UI, tiap perubahan
 * UI memakan sesi — pada 13 Agu 2026 itu memakan ~3,5 jam data.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** URL app, hanya untuk disebut di peringatan. Collector sendiri tidak menyajikan apa pun. */
const APP_URL = process.env.APP_URL ?? 'https://whale.scanner.local';

const ipot = new IpotClient(join(ROOT, 'logs'));
const archive = new TradeArchive(join(ROOT, 'logs'), Number(process.env.ARCHIVE_DAYS ?? 30));
const bus = new BusServer();

const log = (m: string) => console.log(`  ${m}`);
const hr = () => console.log('─'.repeat(64));

let phase = 'mulai';
let lastQr: { qrcode: string; span: number; at: number } | null = null;

bus.greeting = () => ({
  t: 'hello',
  loggedIn: ipot.loggedIn,
  subscribed: ipot.subscribed,
  marketOpen: marketLikelyOpen(),
});

function setPhase(p: string) {
  phase = p;
  bus.send({ t: 'session', loggedIn: ipot.loggedIn, phase });
}

// ---- feed -------------------------------------------------------------------

ipot.on('trade', (t) => {
  // Arsip lebih dulu: kalau app sedang mati atau lambat, transaksinya tetap tersimpan.
  archive.write(t.raw);
  bus.send({ t: 'lt', d: t.raw });
});

/** Pengukuran OB2. Sengaja hanya menghitung dan menyimpan CONTOH, bukan mengarsipkan
 *  semuanya: bentuk datanya belum dipahami dan biayanya belum diketahui — dua alasan
 *  untuk tidak menulis apa pun ke disk dalam jumlah besar dulu. */
const ob2 = { n: 0, bytes: 0, mulai: 0, per: new Map<string, number>(), contoh: [] as string[] };
ipot.on('ob2', (f) => {
  if (!ob2.mulai) ob2.mulai = Date.now();
  ob2.n++; ob2.bytes += f.bytes;
  ob2.per.set(f.code, (ob2.per.get(f.code) ?? 0) + 1);
  if (ob2.contoh.length < 3) ob2.contoh.push(JSON.stringify(f.raw).slice(0, 900));
  // Diteruskan mentah ke app — TIDAK diarsipkan. Orderbook cuma bermakna saat ini
  // juga, dan menyimpannya berarti ratusan MB sehari untuk data yang basi seketika.
  bus.send({ t: 'ob2', code: f.code, d: typeof f.raw === 'string' ? f.raw : JSON.stringify(f.raw) });
});
setInterval(() => {
  if (!ob2.n) return;
  const dtk = (Date.now() - ob2.mulai) / 1000;
  const kbMenit = ob2.bytes / 1024 / dtk * 60;
  log(`OB2: ${ob2.n} pesan · ${(ob2.n / dtk).toFixed(1)}/dtk · ${kbMenit.toFixed(0)} KB/menit`
    + ` · ${ob2.per.size} emiten · ${[...ob2.per].map(([c, n]) => `${c}:${n}`).join(' ')}`);
  if (ob2.contoh.length) { log(`OB2 contoh: ${ob2.contoh.shift()}`); }
}, 30_000);

ipot.on('status', (m) => { log(m); bus.send({ t: 'status', msg: m }); });

ipot.on('qr', (info) => {
  lastQr = { qrcode: info.qrcode, span: info.span, at: Date.now() };
  bus.send({ t: 'qr', qrcode: info.qrcode, span: info.span });
  if (bus.clientCount === 0) {
    hr();
    console.log(`  Belum ada app yang tersambung — QR dicetak di sini (berlaku ${info.span} detik).`);
    console.log(`  Lebih enak: buka ${APP_URL}\n`);
    qrcodeTerminal.generate(info.qrcode, { small: true });
    hr();
  } else {
    log(`QR diteruskan ke app (berlaku ${info.span} detik)`);
  }
  setPhase('menunggu scan');
});

ipot.on('login', () => {
  lastQr = null;
  log('login berhasil');
  // Header halaman dikosongkan — teks "login berhasil" menempel terus dan tidak
  // menambah informasi apa pun setelah dashboard tampil.
  setPhase('');
  ipot.subscribeLiveTrade();
});

let unknownCount = 0;
ipot.on('unknown', (m) => {
  if (++unknownCount <= 15) {
    console.log(`  [?] ${typeof m === 'string' ? m.slice(0, 300) : JSON.stringify(m).slice(0, 300)}`);
  }
});

// ---- koneksi ----------------------------------------------------------------

let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

ipot.on('closed', (why) => {
  log(`koneksi IPOT ${why}`);
  const delay = Math.min(30_000, 2_000 * 2 ** reconnectAttempt++);
  setPhase(`terputus (${why}) — menyambung ulang dalam ${Math.round(delay / 1000)} detik`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { void startSession(); }, delay);
});

async function startSession() {
  // Batalkan reconnect yang sudah dijadwalkan. `requestQr()` menutup koneksi lalu
  // menyambung ulang sendiri, sementara penangan 'closed' JUGA menjadwalkan reconnect
  // 2 detik kemudian — tanpa pembatalan ini keduanya jalan dan kita berakhir dengan dua
  // koneksi ke IPOT sekaligus. Server membaca itu sebagai dua sesi dan mencabut token.
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try {
    const authenticated = await ipot.connect();
    reconnectAttempt = 0;
    if (authenticated) {
      log('sesi dipulihkan dari token tersimpan — tidak perlu scan ulang');
      setPhase('sesi dipulihkan');
      ipot.subscribeLiveTrade();
    } else {
      if (ipot.hasSavedSession()) {
        log('token tersimpan sudah tidak berlaku — perlu scan QR lagi');
        ipot.clearSession();
      }
      setPhase('siap login');
      console.log(`\n  Buka  →  ${APP_URL}  lalu klik "Tampilkan QR"\n`);
    }
    ipot.startWatchdog();
  } catch (e) {
    const delay = Math.min(30_000, 2_000 * 2 ** reconnectAttempt++);
    log(`gagal menyambung: ${(e as Error).message} — coba lagi ${Math.round(delay / 1000)} detik`);
    setPhase('gagal menyambung, mencoba lagi…');
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { void startSession(); }, delay);
  }
}

// ---- perintah dari app ------------------------------------------------------

/**
 * Umur koneksi yang masih dipercaya untuk login QR.
 *
 * Kejadian 14 Agu 2026: collector jalan tanpa login selama ~16 jam, koneksi WebSocket-nya
 * tetap hidup dan tetap menerima notifikasi IDX — tapi QR yang di-scan **tidak pernah
 * menghasilkan konfirmasi login**. Server diam sama sekali: tidak ada frame balasan,
 * tidak ada penolakan. Setelah collector di-restart (yang berarti `appsession` baru,
 * lihat connect()), scan pertama langsung berhasil.
 *
 * Jadi yang basi bukan socket-nya, melainkan `appsession` yang dipakai saat menyambung.
 * Batas persisnya tidak diketahui — yang terbukti hanya: 28 menit masih bisa, ~16 jam
 * tidak. Ambang di bawah sengaja jauh lebih ketat daripada perlu, karena reconnect cuma
 * makan 2–3 detik sementara gagal login diam-diam memakan berjam-jam data.
 */
const STALE_LOGIN_MS = 5 * 60_000;

/** Minta QR, sambung ulang dulu kalau koneksinya sudah tidak segar. */
async function requestQr() {
  const age = ipot.connectedAt ? Date.now() - ipot.connectedAt : Infinity;
  if (!ipot.loggedIn && age > STALE_LOGIN_MS) {
    log(`koneksi sudah ${Math.round(age / 60_000)} menit — sambung ulang dulu agar token sesi segar`);
    setPhase('menyegarkan koneksi…');
    ipot.close();
    await startSession();
    if (!ipot.connected) return;   // gagal; startSession sudah menjadwalkan percobaan lagi
  }
  log('permintaan QR dari app');
  ipot.requestQrLogin();
}

bus.on('command', (msg) => {
  if (msg.cmd === 'qr') { void requestQr(); }
  if (msg.cmd === 'subscribe') { log('subscribe manual dari app'); ipot.subscribeLiveTrade(); }
  if (msg.cmd === 'logout') {
    log('logout diminta dari app');
    ipot.clearSession();
    ipot.loggedIn = false;
    setPhase('keluar…');
    ipot.close();
    setTimeout(() => { void startSession(); }, 400);
  }
  // App membaca arsip langsung dari disk untuk riwayat & panel detail. Flush di sini
  // supaya transaksi beberapa detik terakhir (masih di buffer) ikut terbaca.
  if (msg.cmd === 'flush') { archive.flush(); bus.send({ t: 'flushed', id: msg.id }); }
  // Pengukuran OB2: dinyalakan lewat perintah, bukan otomatis saat start. Biayanya
  // belum diketahui, jadi jangan sampai satu restart diam-diam membanjiri koneksi.
  if (msg.cmd === 'ob2' && Array.isArray(msg.codes)) {
    const codes = (msg.codes as unknown[]).filter((c): c is string => typeof c === 'string');
    for (const c of codes) ipot.subscribeOb2(c);
    log(`OB2 dilangganan: ${codes.join(' ')}`);
  }
  if (msg.cmd === 'ob2stop' && Array.isArray(msg.codes)) {
    for (const c of msg.codes as string[]) ipot.unsubscribeOb2(c);
    log(`OB2 dihentikan: ${(msg.codes as string[]).join(' ')}`);
  }
});

bus.on('clients', (n) => log(`app tersambung: ${n}`));

// ---- peringatan belum login -------------------------------------------------
// Ditangani di collector, bukan app: kalau app mati, data tetap terekam dan tidak ada
// yang perlu diperingatkan. Yang berbahaya justru collector tidak login — dan hanya
// collector yang tahu itu.

let preOpenNagDate = '';
setInterval(() => {
  if (!marketPreOpening() || ipot.loggedIn) return;
  const today = wibDateStr();
  if (preOpenNagDate === today) return;
  preOpenNagDate = today;
  hr();
  console.log('  ⚠ Bursa buka 09:00 dan BELUM LOGIN — scan QR sekarang.');
  console.log(`     ${APP_URL}`);
  hr();
  desktopNotify('Whale Scanner belum login',
    `Bursa buka 09:00. Scan QR sekarang di ${APP_URL} supaya awal sesi tidak hilang.`, true);
}, 60_000);

const GRACE_MS = 120_000;
const NAG_MS = 10 * 60_000;
let notLoggedSince: number | null = null;
let lastNag = 0;

setInterval(() => {
  const open = marketLikelyOpen();
  if (!open || ipot.loggedIn) {
    if (notLoggedSince !== null && ipot.loggedIn) {
      const lost = Math.round((Date.now() - notLoggedSince) / 60_000);
      if (lost >= 2) log(`login setelah ${lost} menit tidak terekam saat bursa buka`);
    }
    notLoggedSince = null;
    lastNag = 0;
    bus.send({ t: 'notLogged', mins: 0 });
    return;
  }
  if (notLoggedSince === null) notLoggedSince = Date.now();
  const elapsed = Date.now() - notLoggedSince;
  if (elapsed < GRACE_MS) return;

  const mins = Math.round(elapsed / 60_000);
  bus.send({ t: 'notLogged', mins });
  if (Date.now() - lastNag < NAG_MS) return;
  lastNag = Date.now();
  hr();
  console.log(`  ⚠ BURSA BUKA TAPI BELUM LOGIN — ${mins} menit transaksi TIDAK terekam.`);
  console.log(`     Buka ${APP_URL} lalu scan QR.`);
  hr();
  desktopNotify('Whale Scanner belum login',
    `Bursa buka, ${mins} menit transaksi tidak terekam. Buka ${APP_URL} dan scan QR.`, true);
}, 30_000);

// ---- daur hidup -------------------------------------------------------------

function shutdown(code: number): never {
  archive.flush();
  bus.close();
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
    if (key === 'r') { void requestQr(); }
    if (key === 's') { log('subscribe manual...'); ipot.subscribeLiveTrade(); }
  });
}

async function main() {
  hr();
  console.log('  WHALE COLLECTOR — koneksi IPOT + arsip');
  console.log(`  bursa saat ini: ${marketLikelyOpen() ? 'BUKA' : 'tutup'}`);
  console.log(`  socket        : ${SOCKET_PATH}`);
  console.log(`  arsip         : ${archive.days().length} hari di logs/lt`);
  hr();

  // Padatkan hari lampau yang masih mentah. Dijalankan saat start (bukan hanya saat
  // pergantian hari) supaya arsip lama ikut terurus walau collector jarang menyeberangi
  // tengah malam dalam keadaan hidup.
  const packed = archive.compressBacklog();
  if (packed.length) log(`arsip dipadatkan: ${packed.join(', ')}`);

  await bus.listen();
  await startSession();
  setupKeys();
  console.log('  Cadangan terminal: [r] QR  [s] subscribe  [q] keluar\n');
}

main().catch((err) => {
  console.error('  GAGAL:', err.message);
  process.exit(1);
});

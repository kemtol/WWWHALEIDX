import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IpotClient, marketLikelyOpen } from './ipot.js';
import { UiServer } from './server.js';
import { Scanner, DEFAULT_FILTER } from './filters.js';

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
  const { pass, burst, count } = scanner.evaluate(t);
  if (pass) ui.broadcast({ type: 'trade', trade: t, burst, count });
  if (Date.now() - lastStats > 1000) {
    lastStats = Date.now();
    ui.setState({ stats: scanner.stats });
  }
});

// Peringkat tekanan HAKA/HAKI — agregat, jadi cukup 2 detik sekali.
setInterval(() => {
  if (ui.clientCount === 0) return;
  const top = scanner.pressureTop(15);
  if (top.length) {
    ui.setState({ pressure: top, pressureWindowSec: scanner.config.pressureWindowSec });
  }
}, 2000);

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
    log(`filter diperbarui: minValue=${scanner.config.minValue} watchlist=${scanner.config.watchlist.length || 'semua'}`);
    ui.setState({ filter: scanner.config, stats: scanner.stats });
  }
};

function setupKeys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === '' || key === 'q') { console.log('\n  keluar.'); process.exit(0); }
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

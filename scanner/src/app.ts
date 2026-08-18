import QRCode from 'qrcode';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTrade } from './ipot.js';
import { UiServer } from './server.js';
import { Scanner, DEFAULT_FILTER, type FilterConfig } from './filters.js';
import { TradeArchive, wibDateStr, wibTimestamp } from './archive.js';
import { queryHistory } from './history.js';
import { SymbolTracker } from './symbol.js';
import { MarketBoard, buildCandidates, mergeRows } from './market.js';
import { buildPayload, renderPrompt } from './prompt.js';
import { askAi, aiConfigured } from './ai.js';
import { AiHistory, aiEntryId } from './aihist.js';
import { BusClient, SOCKET_PATH } from './bus.js';

/**
 * App — UI, filter, dan seluruh analitik. Tidak menyentuh IPOT sama sekali.
 *
 * Boleh direstart sesering apa pun: sesi login dipegang collector, jadi restart di sini
 * tidak menuntut scan QR ulang dan tidak menghilangkan satu transaksi pun (collector
 * tetap menulis arsip selama app mati).
 *
 * Yang hilang saat app restart cuma jendela bergulir di memori — burst dan tekanan —
 * dan itu diisi ulang dari arsip saat start (lihat warmup di bawah).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Kunci API dari scanner/.env (di-gitignore). Dimuat di sini, bukan lewat systemd
// `EnvironmentFile`, supaya `npm run app` manual dapat kunci yang sama.
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* belum ada — fitur AI mati */ }

const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }
  : undefined;
const PORT = Number(tls ? (process.env.HTTPS_PORT ?? 443) : (process.env.PORT ?? 3000));

const ui = new UiServer(join(ROOT, 'public'), tls);
const URL_BASE = tls ? `https://${process.env.APP_HOST ?? '127.0.0.1'}` : `http://127.0.0.1:${PORT}`;

/** Filter yang TERAPLIKASI disimpan ke disk supaya restart app tidak mengembalikan
 *  filter ke bawaan. Bentuk form yang belum diterapkan urusannya halaman
 *  (localStorage) — file ini hanya memuat konfigurasi yang benar-benar aktif. */
const CONFIG_PATH = join(ROOT, 'logs', 'config.json');
function loadSavedConfig(): Partial<FilterConfig> {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Partial<FilterConfig>) : {};
  } catch {
    return {};   // belum ada atau rusak — mulai dari bawaan
  }
}
function saveConfig() {
  try { writeFileSync(CONFIG_PATH, JSON.stringify(scanner.config, null, 1)); }
  catch (e) { log(`gagal menyimpan filter: ${(e as Error).message}`); }
}
const scanner = new Scanner({ ...DEFAULT_FILTER, ...loadSavedConfig() });
/** Dibaca saja di sini — collector yang menulis. */
const archive = new TradeArchive(join(ROOT, 'logs'));
const tracker = new SymbolTracker();
/** Papan pasar: agregasi harian SEMUA emiten — sumber tab Kandidat. Diisi dari
 *  arsip saat start (warmup), lalu inkremental dari feed. */
const board = new MarketBoard();
const bus = new BusClient();
const aiHistory = new AiHistory(join(ROOT, 'logs'));

const BACKLOG_MAX = 200;
let backlog: unknown[] = [];

const log = (m: string) => console.log(`  ${m}`);
const hr = () => console.log('─'.repeat(64));

let qrTimer: NodeJS.Timeout | null = null;

/**
 * Status login yang terakhir dikirim ke halaman.
 *
 * `loggedIn` HANYA boleh disiarkan saat nilainya berubah. Collector mengirim update
 * `session` cukup sering (termasuk tepat setelah QR dikirim, dengan phase "menunggu
 * scan"), dan di halaman `setLogged(false)` mereset kotak QR ke placeholder — jadi
 * menyiarkan `loggedIn:false` berulang akan menghapus QR beberapa milidetik setelah
 * ia muncul. Itu persis yang terjadi saat collector dan app baru dipisah.
 */
let lastLoggedIn: boolean | null = null;

function pushSession(loggedIn: boolean, phase?: string) {
  const patch: Record<string, unknown> = {};
  if (phase !== undefined) patch.phase = phase;
  if (loggedIn !== lastLoggedIn) {
    lastLoggedIn = loggedIn;
    patch.loggedIn = loggedIn;
    // Sudah masuk dashboard: QR tidak relevan lagi.
    if (loggedIn) patch.qrSvg = null;
  }
  ui.setState(patch);
}

// ---- aliran dari collector --------------------------------------------------

let lastStats = 0;

bus.on('up', (up) => {
  log(up ? 'tersambung ke collector' : 'collector terputus — menyambung ulang…');
  ui.setState({
    collector: up,
    phase: up ? 'tersambung ke collector' : 'collector tidak berjalan',
  });
});

bus.on('message', async (m) => {
  if (m.t === 'lt') {
    const t = parseTrade(m.d);
    if (!t) return;
    tracker.feed(t, wibDateStr());
    board.feed(t, wibDateStr());
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
    return;
  }

  if (m.t === 'hello') {
    ui.setState({ collector: true });
    // Sertakan phase-nya: tanpa ini header berhenti di "tersambung ke collector" dari
    // bus.on('up') dan terbaca seolah belum login, padahal sesinya masih hidup.
    pushSession(m.loggedIn, m.loggedIn ? '' : 'siap login');
    return;
  }

  if (m.t === 'qr') {
    let svg: string | null = null;
    try {
      svg = await QRCode.toString(m.qrcode, { type: 'svg', margin: 1, width: 320 });
    } catch (e) {
      log(`gagal render QR: ${(e as Error).message}`);
    }
    ui.setState({ phase: 'menunggu scan', qrSvg: svg, qrExpiresAt: Date.now() + m.span * 1000 });
    if (qrTimer) clearTimeout(qrTimer);
    qrTimer = setTimeout(() => ui.setState({ phase: 'QR kedaluwarsa', qrSvg: null }), m.span * 1000);
    return;
  }

  if (m.t === 'session') {
    if (m.loggedIn && qrTimer) clearTimeout(qrTimer);
    // Hanya saat BERALIH ke keluar — bukan setiap kali collector mengabari keadaan.
    // Kalau tidak, statistik ter-reset terus selama menunggu scan.
    const wasLoggedIn = lastLoggedIn;
    pushSession(m.loggedIn, m.phase);
    if (!m.loggedIn && wasLoggedIn) {
      backlog = [];
      scanner.resetStats();
      ui.setState({ stats: scanner.stats });
    }
    return;
  }

  if (m.t === 'status') { ui.setState({ status: m.msg }); return; }
  if (m.t === 'notLogged') { ui.setState({ notLoggedMins: m.mins }); return; }
  if (m.t === 'flushed') { resolveFlush(m.id); return; }
});

// ---- flush arsip atas permintaan --------------------------------------------
// App membaca arsip langsung dari disk, tapi transaksi beberapa detik terakhir masih
// ada di buffer collector. Minta flush dulu supaya riwayat & panel detail tidak
// kehilangan ekornya.

let flushId = 0;
const pendingFlush = new Map<number, () => void>();

function resolveFlush(id: number) {
  const done = pendingFlush.get(id);
  if (done) { pendingFlush.delete(id); done(); }
}

function requestFlush(): Promise<void> {
  if (!bus.connected) return Promise.resolve();
  const id = ++flushId;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { pendingFlush.delete(id); resolve(); }, 1_000);
    pendingFlush.set(id, () => { clearTimeout(timer); resolve(); });
    bus.send({ cmd: 'flush', id });
  });
}

// ---- API & perintah halaman -------------------------------------------------

ui.getBacklog = () => backlog;

/** Berapa emiten teratas yang masuk papan. Dipakai push live MAUPUN prompt AI: kalau
 *  keduanya pakai angka sendiri, prompt berisi kandidat yang tidak ada di layar (atau
 *  sebaliknya) tanpa ada yang sadar. Baris akhirnya bisa lebih banyak dari ini —
 *  `mergeRows` menggabungkan peringkat harian dan peringkat jendela. */
const BOARD_N = 15;

/** Baris kandidat satu tanggal — sumber TUNGGAL untuk tabel Papan maupun prompt AI.
 *  Hari berjalan: gabungan papan harian + tekanan jendela dari memori (instan, dan
 *  persis yang tampil di layar). Hari lampau: dari arsip; kolom tekanan jendela kosong
 *  karena itu konsep live saja. */
function candidatesFor(date: string, n: number) {
  if (date === wibDateStr()) {
    const recordedFrom = archive.startTime(date);
    return {
      date, live: true, recordedFrom,
      rows: mergeRows(board, scanner.pressureAll(), n, { recordedFrom, now: Date.now() }),
    };
  }
  const r = buildCandidates(archive, date, n);
  return {
    date, live: false, recordedFrom: r.recordedFrom,
    rows: r.rows.map((row) => ({ ...row, win: null })),
  };
}

ui.onApi = async (path, q) => {
  if (path === '/api/days') {
    return archive.days().map((d) => ({ date: d, bytes: archive.sizeOf(d) }));
  }

  if (path === '/api/symbol') {
    const code = (q.get('code') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(code)) return { error: 'kode emiten tidak sah' };
    const date = q.get('date') || wibDateStr();
    if (q.get('reload') === '1' || !tracker.isWatching(code, date)) {
      await requestFlush();
      tracker.backfill(code, date, archive.readDay(date));
    }
    const recordedFrom = archive.startTime(date);
    const live = date === wibDateStr();
    return {
      date,
      live,
      recordedFrom,
      detail: tracker.detail(code, { recordedFrom, now: live ? Date.now() : undefined }),
    };
  }

  if (path === '/api/unwatch') {
    tracker.unwatch((q.get('code') ?? '').trim().toUpperCase());
    return { ok: true, watching: tracker.watching() };
  }

  if (path === '/api/candidates') {
    const n = Math.min(Math.max(Number(q.get("n")) || BOARD_N, 1), 50);
    return candidatesFor(q.get('date') || wibDateStr(), n);
  }

  // Prompt analisa siap tempel ke AI. Kandidatnya dari `candidatesFor` yang sama dengan
  // tabel Papan, jadi yang dianalisa model persis yang dilihat di layar — bukan hasil
  // hitungan kedua yang bisa menyimpang diam-diam.
  if (path === '/api/prompt' || path === '/api/ai') {
    const date = q.get('date') || wibDateStr();
    const n = Math.min(Math.max(Number(q.get('n')) || BOARD_N, 1), 30);
    const c = candidatesFor(date, n);
    if (!c.rows.length) return { error: `belum ada kandidat untuk ${date}` };
    let prompt: string;
    try {
      prompt = renderPrompt(buildPayload(c.rows, { date, recordedFrom: c.recordedFrom }));
    } catch (e) {
      return { error: (e as Error).message };
    }
    if (path === '/api/prompt') return { date, count: c.rows.length, prompt };

    // /api/ai — panggil model, hasilnya dirender jadi panel di halaman.
    if (!aiConfigured()) return { error: 'kunci AI belum diset (lihat scanner/.env.example)' };
    const t0 = Date.now();
    try {
      const { result, usage } = await askAi(prompt);
      const tookMs = Date.now() - t0;
      log(`AI: ${result.picks.length} pick · ${usage.promptTokens}+${usage.completionTokens} token`
        + ` · ${Math.round(tookMs / 1000)} dtk`);
      const id = aiEntryId();
      aiHistory.save({ id, ts: Date.now(), date, count: c.rows.length, tookMs, usage, result }, prompt);
      // `prompt` ikut dikirim juga saat berhasil supaya tombol "Salin prompt" di modal
      // tetap berguna — mis. untuk membandingkan jawaban model lain atas data yang sama.
      return { id, date, count: c.rows.length, result, usage, prompt, tookMs };
    } catch (e) {
      const msg = (e as Error).message;
      log(`AI gagal: ${msg}`);
      // Prompt tetap dikirim: kalau panggilan gagal (saldo habis, model sibuk),
      // halaman masih bisa menawarkan salin-manual alih-alih buntu total.
      return { error: msg, prompt };
    }
  }

  // Riwayat analisa AI. Daftar sengaja tanpa `result` penuh — kolom kiri hanya butuh
  // waktu, jumlah pick, dan kodenya; detail diambil saat barisnya dipilih.
  if (path === '/api/ai/list') return { entries: aiHistory.list() };

  if (path === '/api/ai/entry') {
    const e = aiHistory.get((q.get('id') ?? '').trim());
    return e ?? { error: 'riwayat tidak ditemukan' };
  }

  if (path === '/api/history') {
    const list = (k: string) =>
      (q.get(k) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const num = (k: string) => {
      const v = Number(q.get(k));
      return Number.isFinite(v) ? v : undefined;
    };
    const date = q.get('date') || wibDateStr();
    if (date === wibDateStr()) await requestFlush();
    return queryHistory(archive, {
      date,
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

ui.onCommand = (msg) => {
  if (msg.cmd === 'login') { log('minta QR lewat collector…'); bus.send({ cmd: 'qr' }); }
  if (msg.cmd === 'subscribe') { log('subscribe manual lewat collector…'); bus.send({ cmd: 'subscribe' }); }
  if (msg.cmd === 'logout') {
    log('logout lewat collector…');
    backlog = [];
    scanner.resetStats();
    ui.setState({ phase: 'keluar…', loggedIn: false, qrSvg: null, stats: scanner.stats });
    bus.send({ cmd: 'logout' });
  }
  if (msg.cmd === 'pressureWindow' && typeof msg.sec === 'number') {
    scanner.update({ pressureWindowSec: msg.sec });
    saveConfig();
    log(`jendela tekanan: ${msg.sec} detik`);
    ui.setState({ filter: scanner.config, pressureWindowSec: msg.sec });
  }
  if (msg.cmd === 'filter' && msg.config) {
    scanner.update(msg.config as never);
    scanner.resetStats();
    saveConfig();
    backlog = [];
    log(`filter diperbarui: minValue=${scanner.config.minValue} watchlist=${scanner.config.watchlist.length || 'semua'}`);
    ui.setState({ filter: scanner.config, stats: scanner.stats });
  }
};

setInterval(() => {
  if (ui.clientCount === 0) return;
  // Papan: gabungan peringkat nilai harian (papan pasar) dan tekanan jendela —
  // lihat mergeRows. `now` = jam sekarang, bukan transaksi terakhir, supaya
  // emiten yang berhenti bertransaksi terbaca lajunya menurun.
  const today = wibDateStr();
  const opts = { recordedFrom: archive.startTime(today), now: Date.now() };
  ui.setState({ candidates: mergeRows(board, scanner.pressureAll(), BOARD_N, opts) });
}, 2000);

// ---- start ------------------------------------------------------------------

/** Isi jendela burst & tekanan dari arsip hari ini, supaya panel tekanan tidak kosong
 *  selama beberapa menit pertama setelah app direstart. Statistik sengaja tidak ikut
 *  terisi — angka "masuk/lolos" harus menghitung sesi app ini, bukan sejarah arsip. */
function warmup() {
  const today = wibDateStr();
  const lines = archive.readDay(today);
  if (!lines.length) return;
  const cutoff = Date.now() - Math.max(scanner.config.pressureWindowSec, 900) * 1000;
  let used = 0;
  // Dari belakang: yang dibutuhkan hanya ekor beberapa menit terakhir.
  for (const line of lines.slice(-200_000)) {
    const t = parseTrade(line);
    if (!t) continue;
    // Waktu bursa yang asli, bukan waktu baris ini dibaca — kalau tidak, seluruh
    // ekor arsip akan masuk jendela dan tekanan terbaca dari sepanjang hari.
    t.ts = wibTimestamp(today, t.time);
    if (t.ts < cutoff) continue;
    scanner.warmup(t);
    used++;
  }
  if (used) log(`jendela tekanan diisi dari arsip: ${used.toLocaleString('id-ID')} transaksi`);

  // Papan pasar butuh hari UTUH, bukan ekor — peringkat nilai dan footprint bersifat
  // kumulatif sejak pembukaan. Dibaca dari arsip yang sama, sekali untuk kedua tujuan.
  board.warmup(lines, today);
  log(`papan pasar diisi dari arsip: ${board.count().toLocaleString('id-ID')} emiten`);
}

async function main() {
  hr();
  console.log('  WHALE APP — UI, filter, analitik');
  console.log(`  collector via : ${SOCKET_PATH}`);
  hr();

  await ui.listen(PORT);
  log(`UI di ${URL_BASE}`);
  ui.setState({ filter: scanner.config, stats: scanner.stats });

  warmup();
  bus.start();
}

main().catch((err) => {
  console.error('  GAGAL:', err.message);
  process.exit(1);
});

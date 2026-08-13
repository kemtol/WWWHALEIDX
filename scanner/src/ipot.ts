import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN_URL = 'https://indopremier.com/ipc/appsession.js';
const WS_URL = 'wss://ipotapp.ipot.id/socketcluster/';
const ORIGIN = 'https://indopremier.com';

/** Satu transaksi running trade.
 *  Offset field diverifikasi terhadap 30.941 transaksi nyata (11 Agu 2026).
 *  CATATAN: feed LT tidak memuat sisi agresor (beli/jual). Field [0] selalu "B"
 *  dan field [8]–[11] (kemungkinan kode broker) selalu kosong. Untuk HAKA/aggressor
 *  perlu subscribe orderbook (OB2) — belum dikerjakan. */
export interface Trade {
  ts: number;         // waktu diterima (epoch ms)
  time: string;       // HHMMSS dari bursa
  seq: string;        // nomor urut transaksi (global, naik)
  symbol: string;
  board: string;      // RG reguler / NG negosiasi / TN tunai
  price: number;
  lot: number;
  value: number;      // price * lot * 100 — 1 lot = 100 lembar
  prevClose: number;
  change: number;      // vs penutupan kemarin
  changePct: number;
  /** Selisih harga terhadap transaksi SEBELUMNYA di emiten yang sama (field [16]).
   *  Diverifikasi 99,9% pada data rapat — dasar penentuan arah agresor (tick rule). */
  tick: number;
  /** Harga rata-rata tertimbang volume (VWAP), kumulatif sejak pembukaan — field [17],
   *  dibulatkan ke rupiah oleh server. Datang gratis dari feed, tidak perlu dihitung
   *  sendiri, dan sudah benar sejak transaksi pertama yang kita terima walau scanner
   *  baru login tengah hari.
   *
   *  PENTING: dihitung per EMITEN+PAPAN, bukan per emiten. GOTO pernah tercatat VWAP 33
   *  di papan NG sementara di RG 50. Karena NG/TN hanya berisi segelintir transaksi,
   *  VWAP di papan itu sering sama dengan harga transaksinya sendiri — jadi `vsAvgPct`
   *  hanya bermakna untuk RG. Lihat README untuk cara verifikasinya. */
  avg: number;
  /** Harga terhadap VWAP papan yang sama, dalam persen. Positif = transaksi ini
   *  terjadi di atas harga rata-rata hari ini. 0 kalau VWAP tidak tersedia. */
  vsAvgPct: number;
  /** Sisi agresor: `'buy'` = pembeli mengambil offer (HAKA), `'sell'` = penjual
   *  mengambil bid (HAKI), `null` = feed tidak menyebutkannya untuk transaksi ini.
   *
   *  Bukan tebakan tick rule — ini dibaca dari SLOT MANA di antara [13]/[14] yang
   *  berisi angka (lihat parseAggressor). Terverifikasi pada 45.110 transaksi:
   *  99,7% konsisten dengan pasangan harga bid/offer, dan 98,6% sepakat dengan tick
   *  rule pada transaksi yang bisa dinilai keduanya.
   *
   *  Cakupan: 100% transaksi RG selama sesi berjalan (dibanding 18,6% kalau hanya
   *  mengandalkan tick). `null` praktis hanya muncul pada transaksi lelang penutupan
   *  setelah 16:00, dan itu benar — lelang menyilangkan order pada satu harga, jadi
   *  memang tidak ada yang berperan sebagai agresor. */
  aggressor: 'buy' | 'sell' | null;
  raw: string;
}

/**
 * Sisi agresor dari posisi angka di [13]/[14].
 *
 * Feed selalu mengisi paling banyak SATU dari dua slot itu dengan angka ~7 digit;
 * slot lainnya "00". Yang menentukan arah adalah slot mana yang dipakai:
 *
 *   [14] berisi angka  → transaksi di harga OFFER → pembeli yang mengambil (HAKA)
 *   [13] berisi angka  → transaksi di harga BID   → penjual yang mengambil (HAKI)
 *   dua-duanya "00"    → tidak diketahui (36% transaksi)
 *
 * Dasar buktinya: dalam satu emiten, harga pada baris ber-slot [14] konsisten lebih
 * TINGGI daripada baris ber-slot [13] — persis pola bid vs offer. Diuji per transaksi
 * terhadap harga slot seberangnya yang terakhir: 23.113 konsisten vs 66 melanggar.
 *
 * Angka di dalam slotnya sendiri belum jelas artinya (kemungkinan nomor order: naik
 * terus, dan sering berulang sama saat satu order agresor memakan beberapa lawan).
 * Yang dipakai di sini hanya POSISI-nya, bukan nilainya.
 */
export function parseAggressor(p: string[]): 'buy' | 'sell' | null {
  const filled = (s: string | undefined) => !!s && s !== '00' && s !== '' && Number.isFinite(Number(s));
  const bid = filled(p[13]);
  const offer = filled(p[14]);
  if (offer && !bid) return 'buy';
  if (bid && !offer) return 'sell';
  return null;   // dua-duanya kosong, atau dua-duanya terisi (belum pernah terlihat)
}

export interface QrInfo {
  qrcode: string;
  span: number;
  moredata?: boolean;
}

/** Server mengirim JWT sesi (berisi nama pemilik akun) lewat `#setAuthToken`.
 *  Jangan sampai tersimpan polos di log. */
function redact(s: string): string {
  return s
    .replace(/("(?:authToken|token)"\s*:\s*")[^"]{16,}(")/g, '$1[REDACTED]$2')
    .replace(/(appsession=)[A-Za-z0-9]{16,}/g, '$1[REDACTED]');
}

/** Catat setiap frame ke JSONL supaya protokol yang belum dikenal bisa dibedah.
 *  Pelajaran dari versi Rust: jangan pernah menelan pesan diam-diam.
 *  Dibatasi ukurannya — tanpa ini file bisa tumbuh ratusan MB per hari bursa. */
class FrameLog {
  private static readonly MAX_BYTES = 20 * 1024 * 1024;
  private path: string;
  private bytes: number;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'frames.jsonl');
    try { this.bytes = statSync(this.path).size; } catch { this.bytes = 0; }
  }
  write(dir: 'UP' | 'DOWN', data: string) {
    try {
      if (this.bytes > FrameLog.MAX_BYTES) {
        writeFileSync(this.path, '');
        this.bytes = 0;
      }
      const line = JSON.stringify({ t: Date.now(), dir, data: redact(data) }) + '\n';
      appendFileSync(this.path, line);
      this.bytes += line.length;
    } catch { /* logging tidak boleh menjatuhkan aplikasi */ }
  }
}

export async function fetchAppSession(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    headers: {
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0',
      'Origin': ORIGIN,
      'Referer': `${ORIGIN}/`,
    },
  });
  if (!res.ok) throw new Error(`gagal ambil appsession: HTTP ${res.status}`);
  const text = await res.text();
  const m =
    text.match(/appsession\s*[:=]\s*["']([^"']+)["']/) ??
    text.match(/appsession[^A-Za-z0-9\-_]{0,30}([A-Za-z0-9\-_]{16,128})/);
  if (!m) throw new Error('token appsession tidak ditemukan di respons');
  return m[1];
}

/** Bursa buka? Dipakai watchdog supaya tidak reconnect terus saat pasar tutup.
 *  IDX: Sen–Jum, sesi 1 mulai 09:00, sesi 2 selesai ~15:50 (istirahat siang bervariasi). */
export function marketLikelyOpen(d = new Date()): boolean {
  const wib = new Date(d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60_000);
  const day = wib.getDay();
  if (day === 0 || day === 6) return false;
  const mins = wib.getHours() * 60 + wib.getMinutes();
  const inS1 = mins >= 9 * 60 && mins < 12 * 60;
  const inS2 = mins >= 13 * 60 + 30 && mins < 16 * 60;
  return inS1 || inS2;
}

type Events = {
  open: [boolean];        // true = sesi sudah terautentikasi lewat token tersimpan
  qr: [QrInfo];
  login: [any];
  trade: [Trade];
  status: [string];
  unknown: [any];
  closed: [string];       // koneksi putus / dianggap mati — pemanggil yang reconnect
};

export class IpotClient extends EventEmitter<Events> {
  private ws: WebSocket | null = null;
  private cid = 0;
  private cmdid = 0;
  private log: FrameLog;
  private sessionPath: string;
  private cmdHandlers = new Map<number, (result: any, full: any) => void>();
  private ridHandlers = new Map<number, (msg: any) => void>();
  private watchdog: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private lastTradeAt = 0;
  private resubscribes = 0;
  private dead = false;

  authToken: string | null = null;
  loggedIn = false;
  subscribed = false;

  constructor(logDir: string) {
    super();
    this.log = new FrameLog(logDir);
    this.sessionPath = join(logDir, 'session.json');
    this.loadSession();
  }

  // ---- sesi tersimpan -------------------------------------------------------

  private loadSession() {
    try {
      const raw = JSON.parse(readFileSync(this.sessionPath, 'utf8'));
      if (typeof raw?.authToken === 'string') this.authToken = raw.authToken;
    } catch { /* belum ada sesi tersimpan */ }
  }

  private saveSession() {
    try {
      writeFileSync(this.sessionPath, JSON.stringify({ authToken: this.authToken }), { mode: 0o600 });
    } catch (e) {
      this.emit('status', `gagal simpan sesi: ${(e as Error).message}`);
    }
  }

  hasSavedSession() { return !!this.authToken; }

  clearSession() {
    this.authToken = null;
    try { writeFileSync(this.sessionPath, '{}', { mode: 0o600 }); } catch { /* abaikan */ }
  }

  // ---- koneksi --------------------------------------------------------------

  /** Menyambung dan handshake. Mengembalikan status autentikasi dari server. */
  async connect(): Promise<boolean> {
    this.dead = false;
    this.subscribed = false;
    this.resubscribes = 0;

    const appsession = await fetchAppSession();
    const ws = new WebSocket(`${WS_URL}?appsession=${appsession}`, {
      headers: { Origin: ORIGIN, 'User-Agent': 'Mozilla/5.0' },
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      ws.once('open', () => { ws.off('error', onErr); resolve(); });
      ws.once('error', onErr);
    });

    this.lastMessageAt = Date.now();
    this.lastTradeAt = Date.now();
    ws.on('message', (buf) => this.onMessage(buf.toString()));
    ws.on('close', (code) => this.die(`ditutup server (code ${code})`));
    ws.on('error', (err) => this.die(`error: ${err.message}`));

    // Kirim token tersimpan kalau ada — inilah yang membuat reconnect tidak perlu scan ulang.
    const cid = ++this.cid;
    const authenticated = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      this.ridHandlers.set(cid, (msg) => {
        clearTimeout(timer);
        resolve(msg?.data?.isAuthenticated === true);
      });
      this.raw(JSON.stringify({
        event: '#handshake',
        data: { authToken: this.authToken },
        cid,
      }));
    });

    this.loggedIn = authenticated;
    this.emit('open', authenticated);
    return authenticated;
  }

  /** Tandai koneksi mati satu kali saja, lalu serahkan ke pemanggil untuk reconnect. */
  private die(why: string) {
    if (this.dead) return;
    this.dead = true;
    this.stopWatchdog();
    try { this.ws?.terminate(); } catch { /* abaikan */ }
    this.ws = null;
    this.emit('closed', why);
  }

  /** Deteksi socket yang mati diam-diam: tersambung tapi tidak ada apa-apa lagi masuk.
   *  Ini yang menyebabkan feed berhenti tanpa pesan error. */
  startWatchdog() {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      const now = Date.now();
      // Tidak ada pesan apa pun (termasuk ping) = socket benar-benar mati.
      if (now - this.lastMessageAt > 75_000) {
        return this.die(`tidak ada pesan ${Math.round((now - this.lastMessageAt) / 1000)} detik`);
      }
      // Socket hidup tapi stream berhenti saat bursa buka: coba subscribe ulang dulu.
      if (this.subscribed && marketLikelyOpen() && now - this.lastTradeAt > 60_000) {
        if (this.resubscribes < 2) {
          this.resubscribes++;
          this.emit('status', `stream sepi 60 detik — subscribe ulang (${this.resubscribes}/2)`);
          this.lastTradeAt = now;
          this.subscribeLiveTrade();
        } else {
          this.die('subscribe ulang tidak menolong, stream tetap sepi');
        }
      }
    }, 10_000);
  }

  private stopWatchdog() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  // ---- protokol -------------------------------------------------------------

  private raw(payload: string) {
    this.log.write('UP', payload);
    try { this.ws?.send(payload); } catch { /* socket sudah mati */ }
  }

  send(event: string, param: unknown): number {
    const cmdid = this.cmdid++;
    this.raw(JSON.stringify({ event, data: { cmdid, param }, cid: ++this.cid }));
    return cmdid;
  }

  private onMessage(text: string) {
    this.lastMessageAt = Date.now();

    if (text === '#1') { this.ws?.send('#2'); return; }

    let msg: any;
    try { msg = JSON.parse(text); }
    catch { this.log.write('DOWN', text); return this.emit('unknown', text); }

    // Frame LT sengaja TIDAK masuk frames.jsonl: jumlahnya ratusan ribu per hari,
    // menenggelamkan frame protokol lain sampai file memotong diri sendiri di 20 MB
    // (hari ini isinya 99,9% LT — persis masalah yang mau dihindari). Payload LT
    // diarsipkan utuh per hari di logs/lt/ lewat archive.ts, jadi tidak ada yang
    // hilang. Yang GAGAL di-parse tetap dicatat di bawah — justru itu yang menarik.
    const isLt = (msg.event === 'stream' || msg.event === '#publish') &&
                 (msg?.data?.rtype ?? msg?.rtype) === 'LT';
    if (!isLt) this.log.write('DOWN', text);

    // JWT sesi — disimpan supaya reconnect tidak perlu scan QR lagi.
    if (msg.event === '#setAuthToken') {
      const tok = msg?.data?.token;
      if (typeof tok === 'string' && tok.length > 20) {
        this.authToken = tok;
        this.saveSession();
        this.emit('status', 'token sesi disimpan (reconnect tidak perlu scan ulang)');
      }
      return;
    }

    if (typeof msg.rid === 'number') {
      const h = this.ridHandlers.get(msg.rid);
      if (h) { this.ridHandlers.delete(msg.rid); h(msg); return; }
      if (msg.error) return this.emit('status', `ERROR dari server: ${JSON.stringify(msg.error)}`);
      return;
    }

    if (msg.event === 'record') {
      const cmdid = msg?.data?.cmdid;
      const result = msg?.data?.data?.result;
      const handler = this.cmdHandlers.get(cmdid);
      if (handler) return handler(result, msg);
      return this.emit('unknown', msg);
    }

    if (msg.event === 'stream' || msg.event === '#publish') {
      const rtype = msg?.data?.rtype ?? msg?.rtype;
      const payload = msg?.data?.data ?? msg?.data;
      if (rtype === 'LT' && typeof payload === 'string') {
        const trade = parseTrade(payload);
        if (trade) {
          this.lastTradeAt = Date.now();
          this.resubscribes = 0;
          return this.emit('trade', trade);
        }
        this.log.write('DOWN', text);
        return this.emit('status', `frame LT gagal di-parse: ${payload.slice(0, 120)}`);
      }
      return this.emit('unknown', msg);
    }

    if (msg.event === 'notif') {
      const name = msg?.data?.info?.name;
      if (name) this.emit('status', `IDX: ${name}`);
      return;
    }

    this.emit('unknown', msg);
  }

  requestQrLogin() {
    const cmdid = this.send('login', { cmd: 'getqr', lazy: true });
    this.cmdHandlers.set(cmdid, (result, full) => {
      const info = result?.info;
      if (info?.qrcode) return this.emit('qr', info as QrInfo);
      this.loggedIn = true;
      this.emit('login', full);
    });
  }

  /** Subscribe running trade. Bentuk ini disalin persis dari klien web IPOT:
   *  tanpa `code`, tanpa `subsid`. Menambahkan keduanya membuat server balas NOSERVICE. */
  subscribeLiveTrade() {
    this.send('cmd', { cmd: 'subscribe', service: 'mi', rtype: 'LT', subscribe: true });
    this.subscribed = true;
    this.lastTradeAt = Date.now();
    this.emit('status', 'subscribe Live Trade dikirim');
  }

  close() { this.stopWatchdog(); this.dead = true; try { this.ws?.close(); } catch { /* */ } }
}

/**
 * Format pipe IPOT — 20 field, dipetakan dari data nyata:
 *
 *   B |133123| 0 |ULTJ| RG |01262562|1505| 4 |--|-|--|-|1495|00|3460056|10|0|1499|0|1
 *   0    1     2    3    4      5      6   7  8  9 10 11  12  13   14   15 16  17 18 19
 *
 *   [1] jam HHMMSS      [3] emiten        [4] papan RG/NG/TN   [5] nomor urut
 *   [6] harga           [7] lot           [12] harga penutupan sebelumnya
 *   [15] perubahan (= [6]-[12], cocok 30941/30941)
 *   [16] tick (selisih vs transaksi sebelumnya di emiten yang sama)
 *   [17] VWAP emiten, kumulatif sejak pembukaan
 *   [18] % perubahan (dibulatkan ke bawah, cocok 30941/30941)
 *   [0]=B, [2]=0, [19]=1 selalu konstan; [8]-[11] selalu kosong.
 *   [13]/[14] angka ~7 digit di salah satu slot saja (yang lain "00"). NILAI-nya belum
 *   jelas, tapi SLOT-nya menandai sisi agresor — [13] bid, [14] offer. Lihat
 *   parseAggressor. Jangan baca kedua indeks itu sebagai field tetap.
 */
export function parseTrade(data: string): Trade | null {
  const p = data.split('|');
  if (p.length < 19) return null;

  const price = Number(p[6]);
  const lot = Number(p[7]);
  const prevClose = Number(p[12]);
  if (!Number.isFinite(price) || !Number.isFinite(lot)) return null;

  const changePct = Number.isFinite(prevClose) && prevClose > 0
    ? ((price - prevClose) / prevClose) * 100
    : 0;

  const avgRaw = Number(p[17]);
  const avg = Number.isFinite(avgRaw) && avgRaw > 0 ? avgRaw : 0;

  return {
    ts: Date.now(),
    time: p[1] ?? '',
    seq: p[5] ?? '',
    symbol: p[3] ?? '',
    board: p[4] ?? '',
    price,
    lot,
    value: price * lot * 100,
    prevClose: Number.isFinite(prevClose) ? prevClose : 0,
    change: Number.isFinite(prevClose) ? price - prevClose : 0,
    changePct,
    tick: Number(p[16]) || 0,
    avg,
    vsAvgPct: avg > 0 ? ((price - avg) / avg) * 100 : 0,
    aggressor: parseAggressor(p),
    raw: data,
  };
}

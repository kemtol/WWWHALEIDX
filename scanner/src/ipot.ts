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
  raw: string;
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
    this.log.write('DOWN', text);

    let msg: any;
    try { msg = JSON.parse(text); } catch { return this.emit('unknown', text); }

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
 *   [18] % perubahan (dibulatkan ke bawah, cocok 30941/30941)
 *   [0]=B, [2]=0, [19]=1 selalu konstan; [8]-[11] selalu kosong; [13][14][16][17] belum jelas.
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
    raw: data,
  };
}

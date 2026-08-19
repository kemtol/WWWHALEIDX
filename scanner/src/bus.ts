import { createServer, connect, type Socket, type Server } from 'node:net';
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Saluran antara collector (pemegang koneksi & sesi IPOT) dan app (UI + analitik).
 *
 * Alasan keberadaannya: selama koneksi IPOT hidup di proses yang sama dengan UI,
 * setiap perubahan kode UI memaksa restart — dan restart memutus sesi login, yang
 * ditolak IPOT saat dipulihkan (`#removeAuthToken`), jadi wajib scan QR ulang. Pada
 * 13 Agu 2026 itu memakan ~3,5 jam data. Dengan pemisahan ini app bisa direstart
 * sesering apa pun tanpa menyentuh sesi.
 *
 * Unix socket, bukan port TCP: tidak menambah port yang perlu dijaga, dan izinnya
 * bisa dikunci ke pemilik saja (0600).
 *
 * Bingkai pesan: satu JSON per baris. Transaksi dikirim sebagai payload pipe MENTAH
 * (`{t:'lt',d:'B|...'}`) alih-alih objek Trade — lossless, ~72 byte alih-alih ~400,
 * dan app sudah punya parseTrade untuk membacanya.
 */

export const SOCKET_PATH =
  process.env.WHALE_SOCKET ??
  `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/whale-scanner.sock`;

/** Collector → app. */
export type Down =
  | { t: 'hello'; loggedIn: boolean; subscribed: boolean; marketOpen: boolean }
  | { t: 'lt'; d: string }
  /** Frame orderbook mentah. Diteruskan apa adanya supaya analitik tetap di app —
   *  collector sengaja tidak memuat pengetahuan soal isi data. */
  | { t: 'ob2'; code: string; d: string }
  | { t: 'qr'; qrcode: string; span: number }
  | { t: 'session'; loggedIn: boolean; phase: string }
  | { t: 'status'; msg: string }
  | { t: 'notLogged'; mins: number }
  | { t: 'flushed'; id: number };

/** App → collector. */
export type Up =
  | { cmd: 'qr' }
  | { cmd: 'subscribe' }
  | { cmd: 'logout' }
  | { cmd: 'flush'; id: number }
  /** Langganan orderbook per emiten — dinyalakan manual, biayanya belum diukur. */
  | { cmd: 'ob2'; codes: string[] }
  | { cmd: 'ob2stop'; codes: string[] };

/** Pecah aliran byte menjadi baris. Socket tidak menjamin batas pesan, jadi tanpa
 *  ini pesan bisa terbelah di tengah JSON pada saat feed sedang padat. */
function lineReader(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
    // Jaga-jaga terhadap pihak yang mengirim sampah tanpa newline.
    if (buf.length > 1_000_000) buf = '';
  };
}

type BusEvents = {
  command: [Up];
  clients: [number];
};

/** Sisi collector: menerima app yang menyambung. */
export class BusServer extends EventEmitter<BusEvents> {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  /** Dipanggil untuk tiap app yang baru menyambung, supaya ia langsung tahu keadaan. */
  greeting: () => Down = () => ({ t: 'hello', loggedIn: false, subscribed: false, marketOpen: false });

  listen(path = SOCKET_PATH): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    // Socket file yang ditinggalkan proses sebelumnya membuat bind gagal dengan
    // EADDRINUSE walau tidak ada yang mendengarkan.
    try { unlinkSync(path); } catch { /* belum ada */ }

    return new Promise((resolve, reject) => {
      const server = createServer((sock) => {
        sock.setNoDelay(true);
        this.clients.add(sock);
        this.emit('clients', this.clients.size);
        try { sock.write(JSON.stringify(this.greeting()) + '\n'); } catch { /* langsung putus */ }

        sock.on('data', lineReader((line) => {
          try {
            const msg = JSON.parse(line);
            if (typeof msg?.cmd === 'string') this.emit('command', msg as Up);
          } catch { /* abaikan baris yang tidak valid */ }
        }));
        const drop = () => {
          if (this.clients.delete(sock)) this.emit('clients', this.clients.size);
        };
        sock.on('close', drop);
        sock.on('error', drop);
      });

      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        try { chmodSync(path, 0o600); } catch { /* bukan alasan gagal */ }
        this.server = server;
        resolve();
      });
    });
  }

  send(msg: Down) {
    const line = JSON.stringify(msg) + '\n';
    for (const sock of this.clients) {
      // Kalau app tidak sanggup mengikuti, biarkan socket menumpuk daripada
      // menjatuhkan transaksi — arsip tetap ditulis collector, jadi tidak ada
      // yang hilang permanen, dan backpressure-nya terlihat di memori proses.
      if (sock.writable) sock.write(line);
    }
  }

  get clientCount() { return this.clients.size; }

  close() {
    for (const s of this.clients) { try { s.destroy(); } catch { /* */ } }
    this.clients.clear();
    try { this.server?.close(); } catch { /* */ }
    try { unlinkSync(SOCKET_PATH); } catch { /* */ }
  }
}

type ClientEvents = {
  message: [Down];
  /** true = tersambung ke collector, false = terputus. */
  up: [boolean];
};

/** Sisi app: menyambung ke collector, menyambung ulang sendiri kalau collector
 *  belum jalan atau sempat mati. App boleh start lebih dulu. */
export class BusClient extends EventEmitter<ClientEvents> {
  private sock: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;
  connected = false;

  constructor(private path = SOCKET_PATH) { super(); }

  start() {
    this.closed = false;
    this.dial();
  }

  private dial() {
    if (this.closed) return;
    const sock = connect(this.path);
    this.sock = sock;
    sock.setNoDelay(true);

    sock.on('connect', () => {
      this.attempt = 0;
      this.connected = true;
      this.emit('up', true);
    });
    sock.on('data', lineReader((line) => {
      try { this.emit('message', JSON.parse(line) as Down); } catch { /* */ }
    }));
    const retry = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      if (this.connected) { this.connected = false; this.emit('up', false); }
      if (this.closed) return;
      // Backoff pendek: collector biasanya cuma sedang restart, bukan hilang.
      const delay = Math.min(5_000, 500 * 2 ** this.attempt++);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.dial(), delay);
    };
    sock.on('close', retry);
    sock.on('error', retry);
  }

  send(msg: Up) {
    try { if (this.sock?.writable) this.sock.write(JSON.stringify(msg) + '\n'); }
    catch { /* sedang terputus; app tetap jalan */ }
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.sock?.destroy(); } catch { /* */ }
  }
}

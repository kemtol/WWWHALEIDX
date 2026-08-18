import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

export interface TlsOptions { cert: Buffer; key: Buffer; }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Badan POST sebagai JSON. Dibatasi 256 KB — pesan chat paling panjang pun jauh di
 *  bawah itu, dan tanpa batas satu permintaan bisa menghabiskan memori. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const MAX = 256 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX) { req.destroy(); return reject(new Error('badan permintaan terlalu besar')); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('badan permintaan bukan JSON yang sah')); }
    });
    req.on('error', reject);
  });
}

export class UiServer {
  private wss: WebSocketServer;
  private server: http.Server | https.Server;
  private clients = new Set<WebSocket>();
  /** Snapshot status terakhir supaya tab yang baru dibuka tidak melihat layar kosong. */
  private lastState: Record<string, unknown> = { phase: 'starting' };
  /** Perintah dari halaman, mis. tombol "Minta QR" atau perubahan filter. */
  onCommand: (msg: { cmd: string; [k: string]: unknown }) => void = () => {};
  /** Transaksi terakhir yang lolos filter, dikirim ke tab yang baru dibuka supaya
   *  tabelnya tidak mulai dari kosong sambil menunggu transaksi berikutnya. */
  getBacklog: () => unknown[] = () => [];
  /** Handler `/api/*`. Hasilnya dikirim sebagai JSON; `null` berarti 404.
   *  Ditaruh di pemanggil supaya server tetap tidak tahu-menahu soal arsip.
   *  `body` hanya terisi pada POST berbadan JSON (mis. pesan chat yang terlalu
   *  panjang untuk query string). */
  onApi: (path: string, q: URLSearchParams, body?: unknown) => Promise<unknown> | unknown = () => null;

  /** Kalau `tls` diisi, server jalan HTTPS/WSS (dipakai untuk akses via domain lokal
   *  mis. whale.scanner.local). Tanpa `tls`, tetap HTTP biasa seperti sebelumnya. */
  constructor(private publicDir: string, tls?: TlsOptions) {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.onRequest(req, res);
    this.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'state', ...this.lastState }));
      const backlog = this.getBacklog();
      if (backlog.length) ws.send(JSON.stringify({ type: 'backlog', trades: backlog }));
      ws.on('message', (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (typeof msg?.cmd === 'string') this.onCommand(msg);
        } catch { /* abaikan pesan yang tidak valid */ }
      });
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const [urlPath, qs = ''] = (req.url ?? '/').split('?');

    if (urlPath.startsWith('/api/')) {
      try {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        const data = await this.onApi(urlPath, new URLSearchParams(qs), body);
        if (data === null || data === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end('{"error":"tidak dikenal"}');
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: (e as Error).message }));
      }
    }

    const rel = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(this.publicDir, rel));
      res.writeHead(200, {
        'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream',
        // Alat lokal: berkasnya dibaca dari disk tiap permintaan, jadi cache tidak
        // menghemat apa pun — tapi bisa menyajikan halaman lama setelah diedit dan
        // membuatmu mengejar bug yang sudah diperbaiki.
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
    }
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
  }

  /** Kirim ke semua tab yang terbuka. */
  broadcast(msg: Record<string, unknown>) {
    const json = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  /** Update status koneksi/login. `lastState` disimpan utuh sebagai snapshot untuk tab
   *  yang baru connect, tapi yang disiarkan HANYA bagian yang berubah — kalau seluruh
   *  state ikut dikirim tiap detik, form filter di halaman akan tertimpa terus. */
  setState(state: Record<string, unknown>) {
    this.lastState = { ...this.lastState, ...state };
    this.broadcast({ type: 'state', ...state });
  }

  get clientCount() { return this.clients.size; }
}

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

export class UiServer {
  private wss: WebSocketServer;
  private server: http.Server | https.Server;
  private clients = new Set<WebSocket>();
  /** Snapshot status terakhir supaya tab yang baru dibuka tidak melihat layar kosong. */
  private lastState: Record<string, unknown> = { phase: 'starting' };
  /** Perintah dari halaman, mis. tombol "Minta QR" atau perubahan filter. */
  onCommand: (msg: { cmd: string; [k: string]: unknown }) => void = () => {};

  /** Kalau `tls` diisi, server jalan HTTPS/WSS (dipakai untuk akses via domain lokal
   *  mis. whale.scanner.local). Tanpa `tls`, tetap HTTP biasa seperti sebelumnya. */
  constructor(private publicDir: string, tls?: TlsOptions) {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => this.onRequest(req, res);
    this.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'state', ...this.lastState }));
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
    const urlPath = (req.url ?? '/').split('?')[0];
    const rel = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(this.publicDir, rel));
      res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' });
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

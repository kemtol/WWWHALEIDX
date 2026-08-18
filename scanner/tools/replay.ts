import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BusServer } from '../src/bus.js';
import { TradeArchive, wibDateStr } from '../src/archive.js';

/**
 * Replay arsip satu hari sebagai feed "live" melalui bus — untuk menguji app/UI
 * tanpa menyentuh IPOT dan tanpa mengganggu sesi collector yang sebenarnya.
 *
 * Pakai (dua terminal):
 *   WHALE_SOCKET=/tmp/whale-test.sock npx tsx tools/replay.ts [YYYY-MM-DD] [detik]
 *   WHALE_SOCKET=/tmp/whale-test.sock PORT=3999 npx tsx src/app.ts
 *
 * `detik` = lama pemutaran (default 60). 0 = langsung semua, untuk uji API.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const date = process.argv[2] ?? wibDateStr();
const seconds = Number(process.argv[3] ?? 60);

const archive = new TradeArchive(join(ROOT, 'logs'), 30);
const lines = archive.readDay(date);
if (!lines.length) {
  console.error(`tidak ada arsip untuk ${date}`);
  process.exit(1);
}
console.log(`replay ${date}: ${lines.length.toLocaleString('id-ID')} transaksi dalam ${seconds} detik`);

const server = new BusServer();
server.greeting = () => ({ t: 'hello', loggedIn: true, subscribed: true, marketOpen: true });

server.on('command', (m) => {
  // App minta flush sebelum membaca arsip; di replay tidak ada buffer, jawab saja.
  if (m.cmd === 'flush' && typeof m.id === 'number') server.send({ t: 'flushed', id: m.id });
});

await server.listen();
console.log('bus di', process.env.WHALE_SOCKET ?? '(default)');

if (seconds <= 0) {
  for (const line of lines) server.send({ t: 'lt', d: line });
  console.log('selesai (langsung semua)');
  // Biarkan proses hidup supaya app tetap bisa dites.
  setInterval(() => {}, 60_000);
} else {
  const batch = 500;
  const stepMs = (seconds * 1000) / Math.ceil(lines.length / batch);
  let i = 0;
  const timer = setInterval(() => {
    const chunk = lines.slice(i, i + batch);
    for (const line of chunk) server.send({ t: 'lt', d: line });
    i += batch;
    if (i >= lines.length) {
      clearInterval(timer);
      console.log('selesai');
      setInterval(() => {}, 60_000);
    }
  }, stepMs);
}

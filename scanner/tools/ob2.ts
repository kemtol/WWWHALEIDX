import { connect } from 'node:net';
import { SOCKET_PATH } from '../src/bus.js';

/**
 * Nyalakan/matikan langganan OB2 di collector tanpa merestartnya.
 *
 * Bus menerima banyak klien, jadi ini menyambung sebagai klien tambahan di samping app —
 * collector tidak terganggu dan sesi loginnya tidak tersentuh. Itu penting: satu-satunya
 * cara lain menyalakan OB2 adalah restart, dan restart selalu menuntut scan QR ulang.
 *
 *   npx tsx tools/ob2.ts INET KIJA BBCA
 *   npx tsx tools/ob2.ts --stop INET KIJA BBCA
 */

const args = process.argv.slice(2);
const stop = args.includes('--stop');
const codes = args.filter((a) => /^[A-Z]{2,6}$/.test(a));
if (!codes.length) { console.error('sebutkan minimal satu kode emiten'); process.exit(1); }

const sock = connect(SOCKET_PATH, () => {
  sock.write(JSON.stringify({ cmd: stop ? 'ob2stop' : 'ob2', codes }) + '\n');
  console.log(`${stop ? 'stop' : 'mulai'} OB2: ${codes.join(' ')}`);
  console.log('pantau: journalctl --user -u whale-collector.service -f | grep OB2');
  setTimeout(() => { sock.end(); process.exit(0); }, 300);
});
sock.on('error', (e) => {
  console.error('gagal menyambung ke collector:', e.message);
  process.exit(1);
});

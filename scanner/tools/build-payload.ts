import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradeArchive, wibDateStr } from '../src/archive.js';
import { buildCandidates } from '../src/market.js';
import { buildPayload, renderPrompt } from '../src/prompt.js';

/**
 * Payload/prompt analisa AI dari baris perintah, atas arsip satu hari.
 *
 * Bentuk payload dan penggabungan template ada di `src/prompt.ts` — dipakai bersama
 * dengan tombol AI di dashboard (`/api/prompt`), supaya keduanya tidak bisa berbeda.
 * Bedanya cuma sumber kandidat: di sini selalu dari arsip, sementara dashboard memakai
 * papan di memori untuk hari berjalan (persis yang tampil di layar).
 *
 * Pakai:
 *   npx tsx tools/build-payload.ts [YYYY-MM-DD]            → payload JSON ke stdout
 *   npx tsx tools/build-payload.ts [YYYY-MM-DD] --prompt   → prompt lengkap
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOP_N = 12;

const args = process.argv.slice(2);
const wantPrompt = args.includes('--prompt');
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? wibDateStr();

const archive = new TradeArchive(join(ROOT, 'logs'), 30);
if (!archive.readDay(date).length) {
  console.error(`tidak ada arsip untuk ${date}`);
  process.exit(1);
}

const { rows, recordedFrom, lastTime, totalScanned } = buildCandidates(archive, date, TOP_N);
const payload = buildPayload(rows, { date, recordedFrom, lastTime, totalTrades: totalScanned });

console.log(wantPrompt ? renderPrompt(payload) : JSON.stringify(payload, null, 1));

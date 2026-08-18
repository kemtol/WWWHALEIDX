import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradeArchive, wibDateStr } from '../src/archive.js';
import { buildCandidates } from '../src/market.js';

/**
 * Membangun payload analisa untuk rekomendasi AI (PRD 5.3/5.4): ringkasan per emiten
 * kandidat dari arsip satu hari, sekecil mungkin tapi memuat semua sinyal yang dipakai
 * scalper menilai kelayakan. Inilah yang dikirim IDENTIK ke Claude/Kimi/DeepSeek —
 * file mentah ~25 MB tidak mungkin dan tidak perlu masuk prompt.
 *
 * Pemilihan dan indikator kandidat memakai `buildCandidates` dari `src/market.ts` —
 * sumber yang sama dengan tab Kandidat di dashboard, supaya yang dibaca manusia di UI
 * dan yang dianalisa model dijamin tidak berbeda.
 *
 * Pakai:
 *   npx tsx tools/build-payload.ts [YYYY-MM-DD]            → payload JSON ke stdout
 *   npx tsx tools/build-payload.ts [YYYY-MM-DD] --prompt   → prompt lengkap (template
 *                                                            prompts/scalp.md + payload)
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

const miliar = (v: number) => Math.round((v / 1e9) * 10) / 10;
const pct = (v: number) => Math.round(v * 100) / 100;

const payload = {
  meta: {
    tanggal: date,
    terekamDari: recordedFrom,
    transaksiTerakhir: lastTime,
    totalTransaksi: totalScanned,
    catatan:
      recordedFrom && recordedFrom > '090100'
        ? `rekaman baru mulai ${recordedFrom.slice(0, 2)}:${recordedFrom.slice(2, 4)} — opening range & pita VWAP parsial`
        : 'rekaman lengkap sejak pembukaan',
  },
  kandidat: rows.map((r) => ({
    symbol: r.symbol,
    nilaiM: miliar(r.value),
    transaksi: r.trades,
    chgPct: pct(r.chgPct),
    hakaPct: r.hakaPct >= 0 ? Math.round(r.hakaPct) : null,
    deltaM: miliar(r.delta),
    terakhir: r.last,
    vwap: r.vwap !== null ? Math.round(r.vwap) : null,
    zVwap: r.zVwap !== null ? pct(r.zVwap) : null,
    openingRange: r.openingRange,
    profilVolume: r.poc !== null && r.vah !== null && r.val !== null
      ? { poc: r.poc, vah: r.vah, val: r.val }
      : null,
    divergensi15m: r.divergence
      ? { hargaPct: pct(r.divergence.hargaPct), deltaM: miliar(r.divergence.deltaM),
          jenis: r.divergence.jenis }
      : null,
    lajuTape: r.tape !== null ? pct(r.tape) : null,
    footprintTeratas: r.fpTop.map((f) => ({ harga: f.price, beliLot: f.buyLot, jualLot: f.sellLot })),
  })),
};

if (!wantPrompt) {
  console.log(JSON.stringify(payload, null, 1));
  process.exit(0);
}

const tpl = readFileSync(join(ROOT, 'prompts', 'scalp.md'), 'utf8');
if (!tpl.includes('{{DATA_JSON}}')) {
  console.error('prompts/scalp.md tidak punya penanda {{DATA_JSON}}');
  process.exit(1);
}
console.log(tpl.replace('{{DATA_JSON}}', JSON.stringify(payload)));

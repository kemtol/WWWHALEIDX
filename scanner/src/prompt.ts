import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CandidateRow } from './market.js';

/**
 * Payload analisa untuk AI: ringkasan per emiten kandidat, sekecil mungkin tapi memuat
 * semua sinyal yang dipakai scalper menilai kelayakan. Arsip mentah puluhan MB tidak
 * mungkin dan tidak perlu masuk prompt.
 *
 * Modul ini sengaja terpisah dan hanya menerima `CandidateRow[]` yang sudah jadi —
 * TIDAK memilih atau menghitung kandidat sendiri. Dengan begitu tombol AI di dashboard
 * dan `tools/build-payload.ts` menyuapkan baris yang sama persis dengan yang dilihat
 * manusia di layar; kalau modul ini ikut memilih kandidat, keduanya bisa menyimpang
 * tanpa ada yang sadar.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '{{DATA_JSON}}';

export interface PromptMeta {
  date: string;
  /** Jam transaksi pertama di arsip hari itu (HHMMSS), null kalau tidak diketahui. */
  recordedFrom: string | null;
  lastTime?: string | null;
  totalTrades?: number;
}

const miliar = (v: number) => Math.round((v / 1e9) * 10) / 10;
const pct = (v: number) => Math.round(v * 100) / 100;

export function buildPayload(rows: CandidateRow[], meta: PromptMeta) {
  const partial = !!meta.recordedFrom && meta.recordedFrom > '090100';
  return {
    meta: {
      tanggal: meta.date,
      terekamDari: meta.recordedFrom,
      transaksiTerakhir: meta.lastTime ?? null,
      totalTransaksi: meta.totalTrades ?? null,
      catatan: partial
        ? `rekaman baru mulai ${meta.recordedFrom!.slice(0, 2)}:${meta.recordedFrom!.slice(2, 4)}`
          + ' — opening range & pita VWAP parsial'
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
}

/** Template + payload jadi satu prompt siap tempel. Template dibaca tiap panggilan
 *  supaya menyuntingnya tidak menuntut restart app. */
export function renderPrompt(payload: unknown, tplName = 'scalp.md'): string {
  const tpl = readFileSync(join(ROOT, 'prompts', tplName), 'utf8');
  if (!tpl.includes(MARKER)) throw new Error(`prompts/${tplName} tidak punya penanda ${MARKER}`);
  return tpl.replace(MARKER, JSON.stringify(payload));
}

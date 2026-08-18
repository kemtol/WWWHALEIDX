import type { Trade } from './ipot.js';
import { parseTrade } from './ipot.js';
import { wibTimestamp, type TradeArchive } from './archive.js';
import type { Pressure } from './filters.js';
import { SymbolAgg, SymbolTracker, type SymbolDetail } from './symbol.js';

/**
 * Papan pasar — agregasi harian untuk SEMUA emiten, diisi inkremental dari feed dan
 * dipanaskan dari arsip saat start. Inilah sumber data tab Kandidat.
 *
 * Kenapa semua emiten dan bukan yang dipantau saja: peringkat "paling layak dilihat"
 * harus dihitung dari seluruh bursa. Agregat per emiten kecil (beberapa level harga
 * + satu menit-candle per menit), jadi tidak ada alasan membatasi — yang memang tidak
 * scalable adalah OB2, bukan ini (lihat PRD 5.2).
 */

/** Baris ringkas untuk tabel kandidat: `SymbolDetail` tanpa array `minutes`/`footprint`
 *  penuh — yang dikirim ke halaman tiap 2 detik dan yang menjadi dasar payload AI
 *  (PRD 5.4). Footprint dipangkas ke 3 level teramai, sama seperti payload. */
export interface CandidateRow {
  symbol: string;
  value: number;
  trades: number;
  chgPct: number;
  hakaPct: number;      // -1 = bukti kurang
  delta: number;
  last: number;
  /** Pusat VWAP (dari feed) — posisi harga dibacanya lewat zVwap. */
  vwap: number | null;
  zVwap: number | null;
  openingRange: { high: number; low: number; status: 'atas' | 'bawah' | 'dalam'; reliable: boolean } | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  divergence: { hargaPct: number; deltaM: number; jenis: 'bullish' | 'bearish' | null } | null;
  /** Laju tape 60 dtk vs rata-ratanya hari ini (>1 = memanas). */
  tape: number | null;
  fpTop: { price: number; buyLot: number; sellLot: number }[];
}

const FP_TOP = 3;

export function toRow(d: SymbolDetail): CandidateRow {
  return {
    symbol: d.symbol,
    value: d.value,
    trades: d.trades,
    chgPct: d.changePct,
    hakaPct: d.hakaPct,
    delta: d.delta,
    last: d.last,
    vwap: d.bands ? d.bands.vwap : null,
    zVwap: d.bands ? d.bands.z : null,
    openingRange: d.openingRange
      ? { high: d.openingRange.high, low: d.openingRange.low,
          status: d.openingRange.status, reliable: d.openingRange.reliable }
      : null,
    poc: d.profile ? d.profile.poc : null,
    vah: d.profile ? d.profile.vah : null,
    val: d.profile ? d.profile.val : null,
    divergence: d.divergence
      ? { hargaPct: d.divergence.pricePct, deltaM: d.divergence.deltaChange,
          jenis: d.divergence.kind }
      : null,
    tape: d.speed ? d.speed.ratio : null,
    fpTop: [...d.footprint]
      .sort((a, b) => (b.buyLot + b.sellLot + b.unknownLot) - (a.buyLot + a.sellLot + a.unknownLot))
      .slice(0, FP_TOP)
      .map((f) => ({ price: f.price, buyLot: f.buyLot, sellLot: f.sellLot })),
  };
}

export class MarketBoard {
  private aggs = new Map<string, SymbolAgg>();

  count(): number { return this.aggs.size; }

  /** Satu transaksi dari feed. Emiten yang belum dikenal dibuatkan agregatnya;
   *  berpindah hari bursa mengganti agregat lama (app direstart saat itu juga
   *  biasanya, tapi penjaga ini murah dan membuat salah urut tidak fatal). */
  feed(t: Trade, today: string) {
    let agg = this.aggs.get(t.symbol);
    if (!agg || agg.date !== today) {
      agg = new SymbolAgg(t.symbol, today);
      this.aggs.set(t.symbol, agg);
    }
    agg.apply(t);
  }

  /** Isi dari arsip satu hari (payload mentah). parseTrade mengisi `ts` dengan waktu
   *  BACA, bukan waktu transaksi — untuk laju tape itu fatal, jadi diperbaiki dulu
   *  persis seperti di SymbolTracker.backfill. */
  warmup(lines: string[], today: string) {
    for (const line of lines) {
      const t = parseTrade(line);
      if (!t) continue;
      t.ts = wibTimestamp(today, t.time);
      this.feed(t, today);
    }
  }

  /** Baris ringkas untuk tabel, n teratas menurut nilai transaksi hari ini. */
  summarize(n: number, opts: { recordedFrom?: string | null; now?: number } = {}): CandidateRow[] {
    return this.top(n, opts).map(toRow);
  }

  /** Detail satu emiten dari papan — untuk simbol di luar top-n nilai harian
   *  yang ikut tampil lewat peringkat tekanan. */
  detail(symbol: string, opts: { recordedFrom?: string | null; now?: number } = {}): SymbolDetail | null {
    return this.aggs.get(symbol)?.detail(opts) ?? null;
  }

  /** Detail lengkap n emiten teratas menurut nilai. Indikator dihitung hanya untuk
   *  yang lolos — sisanya cukup dilihat `state.value` untuk memeringkat. */
  top(n: number, opts: { recordedFrom?: string | null; now?: number } = {}): SymbolDetail[] {
    return [...this.aggs.values()]
      .sort((a, b) => b.state.value - a.state.value)
      .slice(0, n)
      .map((agg) => agg.detail(opts));
  }
}

/** Baris tabel Papan: indikator hari penuh + tekanan jendela bergulir.
 *  `win` null = emiten tidak punya cukup bukti di jendela (atau mode arsip). */
export type BoardRow = CandidateRow & { win: Pressure | null };

/**
 * Gabungkan dua peringkat: top-n nilai HARIAN (papan pasar) dan top-n nilai
 * JENDELA (tekanan) — union, dedup. Emiten yang ramai pagi tapi sepi sekarang
 * tetap tampil, dan yang baru memanas sekarang ikut muncul walau nilai hariannya
 * kecil. Itu alasan kenapa tabel ini tidak bisa hanya salah satu sumber.
 */
export function mergeRows(
  board: MarketBoard,
  win: Map<string, Pressure>,
  n: number,
  opts: { recordedFrom?: string | null; now?: number } = {},
): BoardRow[] {
  const bySymbol = new Map<string, BoardRow>();
  for (const d of board.top(n, opts)) {
    bySymbol.set(d.symbol, { ...toRow(d), win: win.get(d.symbol) ?? null });
  }
  const winTop = [...win.values()].sort((a, b) => b.value - a.value).slice(0, n);
  for (const w of winTop) {
    if (bySymbol.has(w.symbol)) continue;
    const d = board.detail(w.symbol, opts);
    if (!d) continue;
    bySymbol.set(w.symbol, { ...toRow(d), win: w });
  }
  return [...bySymbol.values()];
}

/** Peringkat n emiten teratas menurut nilai transaksi RG saja.
 *
 *  Sengaja TIDAK memakai queryHistory: ringkasannya menjumlahkan semua papan
 *  termasuk blok negosiasi NG/TN — untuk panel riwayat itu benar (nilai negosiasi
 *  adalah keramaian juga), tapi di sini angka yang ditampilkan (delta, footprint,
 *  POC) semuanya RG, jadi peringkatnya harus RG juga. Kalau tidak, emiten yang
 *  dinaikkan blok nego tampil di urutan atas dengan nilai kecil yang tidak cocok
 *  dengan posisinya. */
function topByRgValue(lines: string[], n: number): { symbols: string[]; total: number } {
  const m = new Map<string, number>();
  let total = 0;
  for (const line of lines) {
    const t = parseTrade(line);
    if (!t) continue;
    total++;
    if (t.board !== 'RG') continue;
    m.set(t.symbol, (m.get(t.symbol) ?? 0) + t.value);
  }
  return {
    symbols: [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([s]) => s),
    total,
  };
}

/** Ringkasan kandidat untuk satu tanggal ARSIP (hari ini atau lampau): peringkat
 *  emiten dari seluruh transaksi RG, lalu indikator penuh hanya untuk n teratas.
 *
 *  Untuk hari BERJALAN gunakan `MarketBoard` — jalur ini membaca dan men-parse arsip
 *  sehari penuh setiap dipanggil (beberapa detik), jadi khusus mode riwayat dan tool
 *  CLI, bukan polling live. */
export function buildCandidates(
  archive: TradeArchive,
  date: string,
  n: number,
): { rows: CandidateRow[]; recordedFrom: string | null; lastTime: string | null; totalScanned: number } {
  const lines = archive.readDay(date);
  const { symbols, total } = topByRgValue(lines, n);

  const tracker = new SymbolTracker();
  for (const sym of symbols) tracker.backfill(sym, date, lines);

  const recordedFrom = archive.startTime(date);
  const lastLine = lines[lines.length - 1] ?? '';
  const lastTime = (lastLine.split('|')[1] ?? '').trim() || null;
  // Acuan laju tape = transaksi TERAKHIR di arsip ini, bukan jam dinding — data
  // lampau harus terbaca persis seperti pada detik terakhirnya terekam.
  const now = lastTime ? wibTimestamp(date, lastTime) : undefined;
  return {
    rows: symbols.map((sym) => toRow(tracker.detail(sym, { recordedFrom, now })!)),
    recordedFrom,
    lastTime,
    totalScanned: total,
  };
}

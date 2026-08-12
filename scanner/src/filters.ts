import type { Trade } from './ipot.js';

/** Semua kriteria di sini bisa dihitung dari feed Live Trade saja.
 *  Yang butuh orderbook (aggressor/HAKA, spread, offer wall) sengaja belum ada. */
export interface FilterConfig {
  enabled: boolean;
  /** Kosong = semua emiten. */
  watchlist: string[];
  minValue: number;        // nilai satu transaksi, Rupiah
  minLot: number;
  boards: string[];        // RG (reguler), NG (negosiasi), TN (tunai)
  minChangePct: number | null;
  maxChangePct: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  timeFrom: string | null; // "HHMM"
  timeTo: string | null;
  burst: {
    enabled: boolean;
    trades: number;        // minimal transaksi...
    windowSec: number;     // ...dalam berapa detik
  };
  /** Jendela perhitungan tekanan HAKA/HAKI, dalam detik. */
  pressureWindowSec: number;
}

/** Tekanan agresor satu emiten dalam jendela berjalan.
 *
 *  hakaPct dihitung HANYA dari transaksi yang benar-benar menggerakkan harga
 *  (tick != 0). Transaksi di harga yang sama sengaja tidak diikutkan: arahnya
 *  tidak dapat diketahui, dan menebaknya lewat pewarisan terbukti membalik
 *  kesimpulan pada 28% emiten. Cakupannya jadi ~17% nilai, tapi tanpa asumsi. */
export interface Pressure {
  symbol: string;
  trades: number;     // seluruh transaksi dalam jendela (untuk mengukur keramaian)
  value: number;      // seluruh nilai dalam jendela
  hakaValue: number;
  hakiValue: number;
  hakaPct: number;    // 0..100, ditimbang NILAI (bukan jumlah transaksi)
  /** Jumlah transaksi yang menggerakkan harga — dasar hakaPct, sekaligus ukuran sampel. */
  evidence: number;
}

/** Default mengikuti konfigurasi Trading Agent Console yang lama,
 *  minus parameter yang butuh orderbook. */
export const DEFAULT_FILTER: FilterConfig = {
  enabled: true,
  watchlist: [],
  minValue: 500_000_000,
  minLot: 0,
  boards: ['RG', 'NG', 'TN'],
  minChangePct: null,
  maxChangePct: null,
  minPrice: null,
  maxPrice: null,
  timeFrom: null,
  timeTo: null,
  burst: { enabled: true, trades: 15, windowSec: 3 },
  pressureWindowSec: 300,
};

export interface Stats {
  seen: number;
  passed: number;
  bursts: number;
}

/** Melacak jendela bergulir per emiten untuk deteksi burst.
 *  Burst dihitung dari SELURUH transaksi emiten itu, bukan hanya yang lolos filter —
 *  kalau tidak, ambang nilai besar akan membuat burst mustahil terpicu. */
export class Scanner {
  config: FilterConfig;
  stats: Stats = { seen: 0, passed: 0, bursts: 0 };
  private windows = new Map<string, number[]>();
  /** Emiten yang sedang berstatus burst, beserta kapan terakhir dipicu. */
  private burstUntil = new Map<string, number>();
  /** Jendela tekanan per emiten: [waktu, nilai, arah(-1/0/1)].
   *  arah 0 = harga tidak bergerak, tidak dipakai menghitung tekanan. */
  private flow = new Map<string, Array<[number, number, number]>>();

  constructor(config: FilterConfig = DEFAULT_FILTER) {
    this.config = config;
  }

  /** Catat trade ke jendela emiten, kembalikan jumlah transaksi dalam jendela. */
  private track(t: Trade): number {
    const w = this.config.burst.windowSec * 1000;
    let arr = this.windows.get(t.symbol);
    if (!arr) { arr = []; this.windows.set(t.symbol, arr); }
    arr.push(t.ts);
    const cutoff = t.ts - w;
    // buang yang sudah lewat jendela (array terurut, cukup potong dari depan)
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr.length;
  }

  /** Catat transaksi ke jendela tekanan. Arah diambil apa adanya dari tick:
   *  0 berarti harga tidak bergerak, dan itu TIDAK ditebak — transaksinya tetap
   *  dicatat untuk ukuran keramaian, tapi tidak ikut menentukan arah tekanan.
   *  Dihitung dari semua transaksi emiten, bukan hanya yang lolos filter. */
  private trackFlow(t: Trade) {
    let arr = this.flow.get(t.symbol);
    if (!arr) { arr = []; this.flow.set(t.symbol, arr); }
    arr.push([t.ts, t.value, Math.sign(t.tick)]);

    const cutoff = t.ts - this.config.pressureWindowSec * 1000;
    let i = 0;
    while (i < arr.length && arr[i][0] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }

  /** Peringkat tekanan, diurutkan dari nilai transaksi terbesar dalam jendela.
   *  Emiten dengan bukti terlalu sedikit tidak ditampilkan — lebih baik kosong
   *  daripada menampilkan angka yang bersandar pada segelintir transaksi. */
  pressureTop(limit = 15, minEvidence = 10): Pressure[] {
    const cutoff = Date.now() - this.config.pressureWindowSec * 1000;
    const out: Pressure[] = [];
    for (const [symbol, arr] of this.flow) {
      let hakaValue = 0, hakiValue = 0, trades = 0, value = 0, evidence = 0;
      for (const [ts, v, dir] of arr) {
        if (ts < cutoff) continue;
        trades++;
        value += v;
        if (dir > 0) { hakaValue += v; evidence++; }
        else if (dir < 0) { hakiValue += v; evidence++; }
      }
      const total = hakaValue + hakiValue;
      if (evidence < minEvidence || total <= 0) continue;
      out.push({
        symbol, trades, value, hakaValue, hakiValue,
        hakaPct: (hakaValue / total) * 100,
        evidence,
      });
    }
    out.sort((a, b) => b.value - a.value);
    return out.slice(0, limit);
  }

  /** Hasil evaluasi satu transaksi. */
  evaluate(t: Trade): { pass: boolean; burst: boolean; count: number } {
    this.stats.seen++;
    const c = this.config;

    this.trackFlow(t);
    const count = this.track(t);
    let burst = false;
    if (c.burst.enabled && count >= c.burst.trades) {
      burst = true;
      const last = this.burstUntil.get(t.symbol) ?? 0;
      // hitung sebagai kejadian baru kalau sudah reda minimal satu jendela
      if (t.ts - last > c.burst.windowSec * 1000) this.stats.bursts++;
      this.burstUntil.set(t.symbol, t.ts);
    }

    if (!c.enabled) { this.stats.passed++; return { pass: true, burst, count }; }

    if (c.watchlist.length && !c.watchlist.includes(t.symbol)) return { pass: false, burst, count };
    if (c.boards.length && !c.boards.includes(t.board)) return { pass: false, burst, count };
    if (t.value < c.minValue) return { pass: false, burst, count };
    if (t.lot < c.minLot) return { pass: false, burst, count };
    if (c.minPrice !== null && t.price < c.minPrice) return { pass: false, burst, count };
    if (c.maxPrice !== null && t.price > c.maxPrice) return { pass: false, burst, count };
    if (c.minChangePct !== null && t.changePct < c.minChangePct) return { pass: false, burst, count };
    if (c.maxChangePct !== null && t.changePct > c.maxChangePct) return { pass: false, burst, count };

    if (c.timeFrom || c.timeTo) {
      const hhmm = t.time.slice(0, 4); // HHMMSS -> HHMM
      if (c.timeFrom && hhmm < c.timeFrom) return { pass: false, burst, count };
      if (c.timeTo && hhmm > c.timeTo) return { pass: false, burst, count };
    }

    this.stats.passed++;
    return { pass: true, burst, count };
  }

  /** Terapkan konfigurasi baru dari UI, abaikan field yang tidak dikenal. */
  update(patch: Partial<FilterConfig>) {
    this.config = {
      ...this.config,
      ...patch,
      burst: { ...this.config.burst, ...(patch.burst ?? {}) },
    };
    // jendela lama tidak valid lagi kalau durasinya berubah
    if (patch.burst?.windowSec !== undefined) this.windows.clear();
  }

  resetStats() { this.stats = { seen: 0, passed: 0, bursts: 0 }; }
}

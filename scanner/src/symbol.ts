import type { Trade } from './ipot.js';
import { parseTrade } from './ipot.js';
import { wibTimestamp } from './archive.js';

/** Satu level harga pada footprint: berapa yang dibeli agresif vs dijual agresif
 *  di harga itu. Inilah yang memperlihatkan di harga mana tekanan menumpuk —
 *  tidak terlihat dari total volume saja. Papan RG saja; NG/TN harganya hasil
 *  negosiasi, kalau dicampur level harganya jadi tidak bermakna. */
export interface FootprintLevel {
  price: number;
  buyLot: number;
  sellLot: number;
  buyValue: number;
  sellValue: number;
  /** Transaksi yang sisinya tidak disebutkan feed (lelang penutupan). */
  unknownLot: number;
  trades: number;
}

/** Agregat satu menit — dipakai melihat ARAH perubahan tekanan, bukan cuma
 *  posisinya. Panel tekanan yang ada hanya snapshot jendela, jadi tidak bisa
 *  membedakan "beli kuat dan menguat" dari "beli kuat tapi mulai habis". */
export interface MinuteBar {
  minute: string;      // "HHMM"
  open: number;
  high: number;
  low: number;
  close: number;
  lot: number;
  value: number;
  /** Nilai beli agresif dikurangi jual agresif dalam menit itu. */
  delta: number;
  trades: number;
}

/** Profil volume harian: di harga mana perdagangan benar-benar terjadi.
 *
 *  POC dan value area dipakai scalper sebagai support/resistance yang berdasar volume
 *  nyata, bukan garis tarikan. Dihitung dari footprint, jadi papan RG saja. */
export interface VolumeProfile {
  /** Harga dengan volume terbesar hari ini (point of control). */
  poc: number;
  /** Batas atas & bawah area yang memuat ~70% volume. */
  vah: number;
  val: number;
  /** Porsi volume yang benar-benar tercakup value area (0..1) — bisa meleset dari 0,7
   *  kalau level harganya sedikit, dan itu harus terlihat daripada dibulatkan diam-diam. */
  coverage: number;
}

/** High/low N menit pertama sesi 1. Breakout dari rentang ini salah satu setup paling
 *  umum untuk day trading, tapi hanya sah kalau perekaman memang mulai dari pembukaan. */
export interface OpeningRange {
  high: number;
  low: number;
  /** Jumlah menit yang benar-benar punya transaksi di dalam rentang itu. */
  bars: number;
  /** Harga terakhir menembus ke atas / ke bawah rentang, atau masih di dalam. */
  status: 'atas' | 'bawah' | 'dalam';
  /** false = arsip hari itu tidak mulai dari pembukaan, jadi angkanya tidak bisa dipercaya. */
  reliable: boolean;
}

/**
 * Divergensi harga terhadap cumulative delta pada jendela bergulir.
 *
 * Harga naik sementara delta turun berarti kenaikan itu tidak didukung pembeli agresif —
 * pertanda tenaga habis. Ini indikator order flow paling klasik, dan bahannya sudah lengkap
 * karena sisi agresor datang dari feed.
 *
 * Sengaja memakai perbandingan awal-akhir jendela, bukan deteksi swing: swing menuntut
 * parameter yang harus dicocok-cocokkan, dan hasilnya sulit dipertanggungjawabkan. Yang di
 * sini bisa dibaca apa adanya — "dalam 15 menit terakhir harga naik 0,8% tapi delta −1,2 M".
 */
export interface Divergence {
  windowMin: number;
  priceFrom: number;
  priceTo: number;
  pricePct: number;
  deltaChange: number;
  /** null = harga dan delta bergerak sejalan, atau geraknya terlalu kecil untuk dinilai. */
  kind: 'bullish' | 'bearish' | null;
  /** Ketidakseimbangan relatif terhadap nilai yang diperdagangkan di jendela itu (0..1). */
  strength: number;
}

/**
 * Pita VWAP — acuan target dan stop yang paling umum dipakai scalper.
 *
 * Pusatnya memakai VWAP dari feed (`avg`), karena itu yang dihitung server sejak
 * pembukaan dan yang dilihat semua pelaku pasar. Simpangan bakunya terpaksa dihitung
 * dari transaksi yang KITA lihat — feed tidak mengirimkannya. Kalau perekaman tidak
 * mulai dari pembukaan, pitanya jadi perkiraan, bukan pasti.
 *
 * `vwapOwn` sengaja ikut dilaporkan: selisihnya terhadap `vwap` feed adalah ukuran
 * langsung seberapa parsial data kita — kalau keduanya berdekatan, pita ini bisa
 * dipercaya.
 */
export interface VwapBands {
  vwap: number;      // dari feed
  vwapOwn: number;   // dihitung dari transaksi yang terlihat
  sd: number;
  upper1: number; lower1: number;
  upper2: number; lower2: number;
  /** Posisi harga terakhir terhadap VWAP, dalam satuan simpangan baku. */
  z: number;
}

/**
 * Laju tape — seberapa cepat transaksi mengalir dibanding rata-ratanya hari ini.
 *
 * Bukan RVOL: pembandingnya rata-rata emiten ini pada hari ini sendiri, bukan perilaku
 * normalnya lintas hari. Untuk itu perlu profil agregat harian yang belum dibuat.
 * Tetap berguna karena lonjakan laju sering mendahului pergerakan harga.
 */
export interface TapeSpeed {
  /** Transaksi per detik dalam 60 detik terakhir. */
  perSec: number;
  /** Nilai per detik dalam 60 detik terakhir, rupiah. */
  valuePerSec: number;
  /** Rata-rata transaksi per detik sepanjang yang terekam hari ini. */
  baseline: number;
  /** perSec dibagi baseline. >1 = sedang lebih ramai dari rata-ratanya sendiri. */
  ratio: number;
}

export interface SymbolDetail {
  symbol: string;
  trades: number;
  lot: number;
  value: number;
  open: number;
  high: number;
  low: number;
  last: number;
  prevClose: number;
  avg: number;              // VWAP dari feed
  changePct: number;
  vsAvgPct: number;
  hakaValue: number;
  hakiValue: number;
  /** Nilai transaksi yang sisinya tidak disebutkan feed. */
  unknownValue: number;
  /** hakaValue - hakiValue, kumulatif sejak transaksi pertama yang terlihat. */
  delta: number;
  /** 0..100 ditimbang nilai; -1 kalau belum ada bukti sama sekali. */
  hakaPct: number;
  minutes: MinuteBar[];
  footprint: FootprintLevel[];
  profile: VolumeProfile | null;
  openingRange: OpeningRange | null;
  divergence: Divergence | null;
  bands: VwapBands | null;
  speed: TapeSpeed | null;
  /** Blok negosiasi/tunai dipisah: nilainya besar tapi tidak punya sisi agresor,
   *  dan harganya di luar mekanisme bid/offer. Menyatukannya akan mengaburkan dua-duanya. */
  blockTrades: number;
  blockValue: number;
}

interface State {
  /** Tanggal bursa yang sedang ditampilkan. Transaksi live hanya boleh masuk kalau
   *  tanggalnya cocok — kalau tidak, membuka detail emiten pada tanggal lampau akan
   *  tercampur transaksi hari ini dan angkanya jadi karangan. */
  date: string;
  /** Nomor urut transaksi tertinggi yang sudah dihitung. Backfill dari arsip dan feed
   *  live bisa bertumpang tindih di ekornya; tanpa penjaga ini transaksi yang sama
   *  terhitung dua kali dan delta jadi menggelembung. Seq global naik terus, jadi cukup
   *  membandingkan angkanya. */
  lastSeq: number;
  trades: number; lot: number; value: number;
  open: number; high: number; low: number; last: number;
  prevClose: number; avg: number;
  hakaValue: number; hakiValue: number; unknownValue: number;
  minutes: Map<string, MinuteBar>;
  footprint: Map<number, FootprintLevel>;
  blockTrades: number; blockValue: number;
  /** Akumulator Welford tertimbang volume untuk simpangan baku harga.
   *  Welford, bukan Σ(q·p²): pada emiten harga tinggi yang ramai, jumlah kuadrat itu
   *  bisa menyentuh batas presisi Number dan variansnya jadi kacau. */
  wSum: number; wMean: number; wM2: number;
  /** Waktu transaksi terakhir (epoch ms) untuk mengukur laju. Dipotong agar tidak tumbuh. */
  recent: number[];
  recentValue: number[];
}

const emptyState = (date: string): State => ({
  date,
  lastSeq: 0,
  trades: 0, lot: 0, value: 0,
  open: 0, high: 0, low: 0, last: 0,
  prevClose: 0, avg: 0,
  hakaValue: 0, hakiValue: 0, unknownValue: 0,
  minutes: new Map(),
  footprint: new Map(),
  blockTrades: 0, blockValue: 0,
  wSum: 0, wMean: 0, wM2: 0,
  recent: [], recentValue: [],
});

/**
 * Agregat satu emiten: state + cara memakannya (apply transaksi, lalu render detail
 * beserta seluruh indikator turunan).
 *
 * Sengaja dipisah dari kelas-kelas pemegangnya: SymbolTracker (panel detail, hanya
 * emiten yang dipantau) dan MarketBoard (semua emiten) SAMA-SAMA membutuhkan
 * matematika ini, dan tidak boleh diduplikasi — kalau ada dua salinan, salah satunya
 * pasti menyimpang suatu hari.
 */
export class SymbolAgg {
  readonly state: State;

  constructor(readonly symbol: string, date: string) {
    this.state = emptyState(date);
  }

  get date() { return this.state.date; }

  apply(t: Trade) {
    const s = this.state;

    const seq = Number(t.seq);
    if (Number.isFinite(seq)) {
      if (seq <= s.lastSeq) return;   // sudah dihitung saat backfill
      s.lastSeq = seq;
    }

    // Blok negosiasi/tunai: dihitung terpisah, tidak masuk footprint maupun candle.
    if (t.board !== 'RG') {
      s.blockTrades++;
      s.blockValue += t.value;
      if (t.prevClose > 0) s.prevClose = t.prevClose;
      return;
    }

    s.trades++;
    s.lot += t.lot;
    s.value += t.value;
    if (!s.open) { s.open = t.price; s.high = t.price; s.low = t.price; }
    if (t.price > s.high) s.high = t.price;
    if (t.price < s.low) s.low = t.price;
    s.last = t.price;
    if (t.prevClose > 0) s.prevClose = t.prevClose;
    if (t.avg > 0) s.avg = t.avg;

    const signed = t.aggressor === 'buy' ? t.value : t.aggressor === 'sell' ? -t.value : 0;
    if (t.aggressor === 'buy') s.hakaValue += t.value;
    else if (t.aggressor === 'sell') s.hakiValue += t.value;
    else s.unknownValue += t.value;

    const key = t.time.slice(0, 4) || '0000';
    let m = s.minutes.get(key);
    if (!m) {
      m = { minute: key, open: t.price, high: t.price, low: t.price, close: t.price,
            lot: 0, value: 0, delta: 0, trades: 0 };
      s.minutes.set(key, m);
    }
    if (t.price > m.high) m.high = t.price;
    if (t.price < m.low) m.low = t.price;
    m.close = t.price;
    m.lot += t.lot;
    m.value += t.value;
    m.delta += signed;
    m.trades++;

    // Simpangan baku harga tertimbang lot (Welford), untuk pita VWAP.
    if (t.lot > 0) {
      s.wSum += t.lot;
      const d1 = t.price - s.wMean;
      s.wMean += (d1 * t.lot) / s.wSum;
      s.wM2 += t.lot * d1 * (t.price - s.wMean);
    }

    // Jejak waktu untuk laju tape. Dipotong berkala supaya tidak tumbuh sepanjang hari;
    // yang dibutuhkan hanya menit terakhir.
    s.recent.push(t.ts);
    s.recentValue.push(t.value);
    if (s.recent.length > 4000) {
      s.recent.splice(0, s.recent.length - 2000);
      s.recentValue.splice(0, s.recentValue.length - 2000);
    }

    let f = s.footprint.get(t.price);
    if (!f) {
      f = { price: t.price, buyLot: 0, sellLot: 0, buyValue: 0, sellValue: 0,
            unknownLot: 0, trades: 0 };
      s.footprint.set(t.price, f);
    }
    f.trades++;
    if (t.aggressor === 'buy') { f.buyLot += t.lot; f.buyValue += t.value; }
    else if (t.aggressor === 'sell') { f.sellLot += t.lot; f.sellValue += t.value; }
    else f.unknownLot += t.lot;
  }

  detail(opts: { recordedFrom?: string | null; now?: number } = {}): SymbolDetail {
    const s = this.state;
    const evidence = s.hakaValue + s.hakiValue;
    const minutes = [...s.minutes.values()].sort((a, b) => a.minute.localeCompare(b.minute));
    const footprint = [...s.footprint.values()].sort((a, b) => b.price - a.price);
    return {
      symbol: this.symbol,
      trades: s.trades, lot: s.lot, value: s.value,
      open: s.open, high: s.high, low: s.low, last: s.last,
      prevClose: s.prevClose, avg: s.avg,
      changePct: s.prevClose > 0 ? ((s.last - s.prevClose) / s.prevClose) * 100 : 0,
      vsAvgPct: s.avg > 0 ? ((s.last - s.avg) / s.avg) * 100 : 0,
      hakaValue: s.hakaValue, hakiValue: s.hakiValue, unknownValue: s.unknownValue,
      delta: s.hakaValue - s.hakiValue,
      hakaPct: evidence > 0 ? (s.hakaValue / evidence) * 100 : -1,
      minutes,
      // Harga tertinggi dulu, seperti orderbook — offer di atas, bid di bawah.
      footprint,
      profile: volumeProfile(footprint),
      openingRange: openingRange(minutes, s.last, opts.recordedFrom ?? null),
      divergence: divergence(minutes),
      bands: vwapBands(s),
      // Tanpa `now` (mis. melihat arsip hari lampau), acuannya transaksi terakhir di data
      // itu. Untuk hari berjalan `now` WAJIB diisi, supaya emiten yang berhenti
      // bertransaksi terbaca lajunya menurun, bukan membeku di angka terakhir.
      speed: tapeSpeed(s, minutes, opts.now ?? s.recent[s.recent.length - 1] ?? Date.now()),
      blockTrades: s.blockTrades, blockValue: s.blockValue,
    };
  }
}

/**
 * Melacak pembacaan order flow untuk emiten yang sedang dipantau.
 *
 * Hanya emiten yang diminta yang dilacak, bukan semua ~686 — bukan karena berat
 * (agregatnya kecil), tapi supaya pola "pantau beberapa emiten" ini sama dengan
 * yang nanti dibutuhkan OB2, yang memang per simbol dan tidak scalable ke semua.
 *
 * Saat sebuah emiten mulai dipantau, datanya diisi dulu dari arsip hari itu
 * (`backfill`) supaya langsung lengkap sejak pembukaan, lalu diperbarui inkremental
 * dari feed live. Tanpa backfill, panel baru mulai terisi dari detik kamu klik —
 * padahal yang menentukan keputusan justru apa yang terjadi sejak pagi.
 */
export class SymbolTracker {
  private aggs = new Map<string, SymbolAgg>();

  watching(): string[] { return [...this.aggs.keys()]; }

  /** Sudah dilacak untuk tanggal itu? Tanggal ikut dicek supaya berpindah tanggal
   *  memaksa muat ulang, bukan menyajikan data hari lain. */
  isWatching(symbol: string, date: string) {
    return this.aggs.get(symbol)?.date === date;
  }

  unwatch(symbol: string) { this.aggs.delete(symbol); }

  /** Isi dari arsip. `lines` adalah payload mentah satu hari (semua emiten);
   *  yang bukan emiten ini dilewati di sini supaya pemanggil tidak perlu menyaring. */
  backfill(symbol: string, date: string, lines: string[]) {
    const agg = new SymbolAgg(symbol, date);
    this.aggs.set(symbol, agg);
    for (const line of lines) {
      // Cek murah sebelum parse: satu hari bisa ratusan ribu baris, dan
      // parse penuh untuk emiten yang tidak diminta itu pemborosan besar.
      if (!line.includes(`|${symbol}|`)) continue;
      const t = parseTrade(line);
      if (!t || t.symbol !== symbol) continue;
      // parseTrade mengisi ts dengan waktu BACA, bukan waktu transaksi. Untuk laju tape
      // itu fatal: seluruh isi arsip akan terlihat terjadi dalam sedetik terakhir.
      t.ts = wibTimestamp(date, t.time);
      agg.apply(t);
    }
  }

  /** Satu transaksi dari feed live. Diabaikan kalau emitennya tidak dipantau, atau
   *  kalau yang sedang ditampilkan adalah tanggal lain. */
  feed(t: Trade, today: string) {
    const agg = this.aggs.get(t.symbol);
    if (agg && agg.date === today) agg.apply(t);
  }

  detail(
    symbol: string,
    opts: { recordedFrom?: string | null; now?: number } = {},
  ): SymbolDetail | null {
    return this.aggs.get(symbol)?.detail(opts) ?? null;
  }
}

/** Pita VWAP dari akumulator Welford. Pusatnya VWAP feed kalau ada; kalau tidak,
 *  jatuh ke VWAP hitungan sendiri agar pita tetap ada meski feed belum mengirim avg. */
function vwapBands(s: State): VwapBands | null {
  if (s.wSum <= 0) return null;
  const vwapOwn = s.wMean;
  const sd = Math.sqrt(Math.max(0, s.wM2 / s.wSum));
  const center = s.avg > 0 ? s.avg : vwapOwn;
  if (!(sd > 0)) return null;
  return {
    vwap: center,
    vwapOwn,
    sd,
    upper1: center + sd, lower1: center - sd,
    upper2: center + 2 * sd, lower2: center - 2 * sd,
    z: (s.last - center) / sd,
  };
}

/** Laju 60 detik terakhir dibanding rata-rata sepanjang yang terekam hari ini. */
function tapeSpeed(s: State, minutes: MinuteBar[], now: number): TapeSpeed | null {
  if (!s.recent.length || !minutes.length) return null;
  const cutoff = now - 60_000;
  let n = 0, value = 0;
  for (let i = s.recent.length - 1; i >= 0 && s.recent[i] >= cutoff; i--) {
    n++;
    value += s.recentValue[i] ?? 0;
  }
  // Baseline dari jumlah menit yang punya transaksi, bukan rentang jam: emiten yang
  // sepi berjam-jam tidak seharusnya terlihat "meledak" hanya karena pembaginya besar.
  const baseline = s.trades / (minutes.length * 60);
  return {
    perSec: n / 60,
    valuePerSec: value / 60,
    baseline,
    ratio: baseline > 0 ? (n / 60) / baseline : 0,
  };
}

const levelVolume = (f: FootprintLevel) => f.buyLot + f.sellLot + f.unknownLot;

/**
 * POC dan value area 70%, cara baku market profile: mulai dari level tervolume, lalu
 * melebar ke sisi yang levelnya lebih besar sampai 70% volume tercakup.
 *
 * Melebar per sisi satu level (bukan sepasang seperti sebagian implementasi) supaya
 * areanya tidak melompati level yang belum diperiksa saat volumenya timpang.
 */
export function volumeProfile(footprint: FootprintLevel[]): VolumeProfile | null {
  if (!footprint.length) return null;
  // Urut harga menaik supaya "sisi atas/bawah" jelas.
  const levels = [...footprint].sort((a, b) => a.price - b.price);
  const total = levels.reduce((n, f) => n + levelVolume(f), 0);
  if (total <= 0) return null;

  let pocIdx = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levelVolume(levels[i]) > levelVolume(levels[pocIdx])) pocIdx = i;
  }

  let lo = pocIdx, hi = pocIdx;
  let acc = levelVolume(levels[pocIdx]);
  const target = total * 0.7;
  while (acc < target && (lo > 0 || hi < levels.length - 1)) {
    const below = lo > 0 ? levelVolume(levels[lo - 1]) : -1;
    const above = hi < levels.length - 1 ? levelVolume(levels[hi + 1]) : -1;
    if (above >= below && above >= 0) { hi++; acc += above; }
    else if (below >= 0) { lo--; acc += below; }
    else break;
  }

  return {
    poc: levels[pocIdx].price,
    val: levels[lo].price,
    vah: levels[hi].price,
    coverage: acc / total,
  };
}

/** Menit pertama sesi 1 yang dihitung sebagai opening range. 09:00–09:29 WIB. */
const OR_FROM = '0900';
const OR_TO = '0929';

export function openingRange(
  minutes: MinuteBar[],
  last: number,
  recordedFrom: string | null,
): OpeningRange | null {
  const bars = minutes.filter((m) => m.minute >= OR_FROM && m.minute <= OR_TO);
  if (!bars.length) return null;
  const high = Math.max(...bars.map((m) => m.high));
  const low = Math.min(...bars.map((m) => m.low));
  return {
    high,
    low,
    bars: bars.length,
    status: last > high ? 'atas' : last < low ? 'bawah' : 'dalam',
    // Kalau arsip baru mulai setelah pembukaan, sebagian rentangnya tidak pernah
    // terlihat — angkanya ada, tapi tidak boleh dipercaya.
    reliable: !recordedFrom || recordedFrom <= '090100',
  };
}

/** Jendela default divergensi. 15 menit: cukup panjang untuk meredam satu-dua transaksi
 *  besar, cukup pendek untuk masih relevan buat scalping. */
const DIV_WINDOW = 15;
/** Di bawah ambang ini geraknya dianggap tidak berarti — tanpa penjaga ini hampir setiap
 *  emiten akan selalu "divergen" karena harga dan delta jarang bergerak persis sejalan. */
const DIV_MIN_PCT = 0.15;
const DIV_MIN_STRENGTH = 0.05;

export function divergence(minutes: MinuteBar[]): Divergence | null {
  if (minutes.length < 2) return null;
  const win = minutes.slice(-DIV_WINDOW);
  if (win.length < 2) return null;

  const priceFrom = win[0].open;
  const priceTo = win[win.length - 1].close;
  const pricePct = priceFrom > 0 ? ((priceTo - priceFrom) / priceFrom) * 100 : 0;
  const deltaChange = win.reduce((n, m) => n + m.delta, 0);
  const value = win.reduce((n, m) => n + m.value, 0);
  const strength = value > 0 ? Math.min(1, Math.abs(deltaChange) / value) : 0;

  let kind: 'bullish' | 'bearish' | null = null;
  if (Math.abs(pricePct) >= DIV_MIN_PCT && strength >= DIV_MIN_STRENGTH) {
    if (pricePct > 0 && deltaChange < 0) kind = 'bearish';   // naik tanpa pembeli agresif
    else if (pricePct < 0 && deltaChange > 0) kind = 'bullish'; // turun tanpa penjual agresif
  }

  return {
    windowMin: win.length,
    priceFrom, priceTo, pricePct,
    deltaChange, kind, strength,
  };
}

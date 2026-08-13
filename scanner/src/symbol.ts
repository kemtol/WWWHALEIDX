import type { Trade } from './ipot.js';
import { parseTrade } from './ipot.js';

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
  trades: number; lot: number; value: number;
  open: number; high: number; low: number; last: number;
  prevClose: number; avg: number;
  hakaValue: number; hakiValue: number; unknownValue: number;
  minutes: Map<string, MinuteBar>;
  footprint: Map<number, FootprintLevel>;
  blockTrades: number; blockValue: number;
}

const emptyState = (date: string): State => ({
  date,
  trades: 0, lot: 0, value: 0,
  open: 0, high: 0, low: 0, last: 0,
  prevClose: 0, avg: 0,
  hakaValue: 0, hakiValue: 0, unknownValue: 0,
  minutes: new Map(),
  footprint: new Map(),
  blockTrades: 0, blockValue: 0,
});

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
  private state = new Map<string, State>();

  watching(): string[] { return [...this.state.keys()]; }

  /** Sudah dilacak untuk tanggal itu? Tanggal ikut dicek supaya berpindah tanggal
   *  memaksa muat ulang, bukan menyajikan data hari lain. */
  isWatching(symbol: string, date: string) {
    return this.state.get(symbol)?.date === date;
  }

  unwatch(symbol: string) { this.state.delete(symbol); }

  /** Isi dari arsip. `lines` adalah payload mentah satu hari (semua emiten);
   *  yang bukan emiten ini dilewati di sini supaya pemanggil tidak perlu menyaring. */
  backfill(symbol: string, date: string, lines: string[]) {
    this.state.set(symbol, emptyState(date));
    for (const line of lines) {
      // Cek murah sebelum parse: satu hari bisa ratusan ribu baris, dan
      // parse penuh untuk emiten yang tidak diminta itu pemborosan besar.
      if (!line.includes(`|${symbol}|`)) continue;
      const t = parseTrade(line);
      if (t && t.symbol === symbol) this.apply(t);
    }
  }

  /** Satu transaksi dari feed live. Diabaikan kalau emitennya tidak dipantau, atau
   *  kalau yang sedang ditampilkan adalah tanggal lain. */
  feed(t: Trade, today: string) {
    const s = this.state.get(t.symbol);
    if (s && s.date === today) this.apply(t);
  }

  private apply(t: Trade) {
    const s = this.state.get(t.symbol);
    if (!s) return;

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

  detail(symbol: string): SymbolDetail | null {
    const s = this.state.get(symbol);
    if (!s) return null;
    const evidence = s.hakaValue + s.hakiValue;
    return {
      symbol,
      trades: s.trades, lot: s.lot, value: s.value,
      open: s.open, high: s.high, low: s.low, last: s.last,
      prevClose: s.prevClose, avg: s.avg,
      changePct: s.prevClose > 0 ? ((s.last - s.prevClose) / s.prevClose) * 100 : 0,
      vsAvgPct: s.avg > 0 ? ((s.last - s.avg) / s.avg) * 100 : 0,
      hakaValue: s.hakaValue, hakiValue: s.hakiValue, unknownValue: s.unknownValue,
      delta: s.hakaValue - s.hakiValue,
      hakaPct: evidence > 0 ? (s.hakaValue / evidence) * 100 : -1,
      minutes: [...s.minutes.values()].sort((a, b) => a.minute.localeCompare(b.minute)),
      // Harga tertinggi dulu, seperti orderbook — offer di atas, bid di bawah.
      footprint: [...s.footprint.values()].sort((a, b) => b.price - a.price),
      blockTrades: s.blockTrades, blockValue: s.blockValue,
    };
  }
}

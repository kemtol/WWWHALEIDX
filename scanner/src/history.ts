import { parseTrade, type Trade } from './ipot.js';
import type { TradeArchive } from './archive.js';

/** Ringkasan satu emiten dalam rentang waktu yang diminta.
 *
 *  Sengaja dihitung dari SELURUH transaksi emiten di rentang itu, bukan hanya yang
 *  cocok dengan `minValue`/`symbols` — sama alasannya dengan burst: kalau ringkasan
 *  ikut disaring ambang nilai besar, "emiten yang rame" jadi tidak terlihat rame. */
export interface SymbolSummary {
  symbol: string;
  trades: number;
  value: number;
  lot: number;
  first: number;      // harga transaksi pertama di rentang
  last: number;       // harga transaksi terakhir di rentang
  high: number;
  low: number;
  /** VWAP emiten pada transaksi terakhir di rentang (field [17] dari feed). */
  avg: number;
  hakaValue: number;
  hakiValue: number;
  /** 0..100, ditimbang nilai. -1 kalau buktinya tidak cukup untuk dinilai. */
  hakaPct: number;
  /** Jumlah transaksi yang sisinya disebutkan feed — dasar hakaPct sekaligus ukuran sampel. */
  evidence: number;
}

export interface HistoryQuery {
  date: string;            // YYYY-MM-DD
  from?: string | null;    // HHMM
  to?: string | null;      // HHMM
  symbols?: string[];      // kosong = semua
  boards?: string[];       // kosong = semua
  minValue?: number;
  limit?: number;
}

export interface HistoryResult {
  date: string;
  from: string | null;
  to: string | null;
  /** Transaksi di rentang waktu ini, sebelum saringan symbols/boards/minValue. */
  scanned: number;
  /** Yang cocok dengan saringan — bisa jauh lebih besar dari `trades.length`. */
  matched: number;
  /** Transaksi cocok yang benar-benar dikirim, TERBARU dulu, dipotong `limit`. */
  trades: Trade[];
  truncated: boolean;
  /** Peringkat emiten paling ramai di rentang ini, nilai terbesar dulu. */
  symbols: SymbolSummary[];
  archived: boolean;
}

const MIN_EVIDENCE = 10;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5_000;

/** Baca arsip satu hari, saring per rentang waktu, dan ringkas per emiten.
 *
 *  Arsip dibaca dan di-parse ulang setiap query. Untuk satu hari bursa (~25 MB,
 *  ratusan ribu baris) itu memakan puluhan milidetik di mesin ini — masih jauh
 *  lebih murah daripada menyimpan indeks yang harus dijaga tetap benar. */
export function queryHistory(archive: TradeArchive, q: HistoryQuery): HistoryResult {
  const lines = archive.readDay(q.date);
  const from = q.from || null;
  const to = q.to || null;
  const symbols = new Set((q.symbols ?? []).map((s) => s.toUpperCase()));
  const boards = new Set(q.boards ?? []);
  const minValue = q.minValue ?? 0;
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const summaries = new Map<string, SymbolSummary>();
  const matches: Trade[] = [];
  let scanned = 0;
  let matched = 0;

  for (const line of lines) {
    const t = parseTrade(line);
    if (!t) continue;

    const hhmm = t.time.slice(0, 4);
    if (from && hhmm < from) continue;
    if (to && hhmm > to) continue;
    scanned++;

    // Ringkasan dulu, sebelum saringan — lihat catatan di SymbolSummary.
    let s = summaries.get(t.symbol);
    if (!s) {
      s = {
        symbol: t.symbol, trades: 0, value: 0, lot: 0,
        first: t.price, last: t.price, high: t.price, low: t.price,
        avg: t.avg, hakaValue: 0, hakiValue: 0, hakaPct: -1, evidence: 0,
      };
      summaries.set(t.symbol, s);
    }
    s.trades++;
    s.value += t.value;
    s.lot += t.lot;
    s.last = t.price;
    if (t.price > s.high) s.high = t.price;
    if (t.price < s.low) s.low = t.price;
    if (t.avg > 0) s.avg = t.avg;
    // Sisi agresor dari feed, sama seperti panel tekanan live — bukan tick rule.
    if (t.aggressor === 'buy') { s.hakaValue += t.value; s.evidence++; }
    else if (t.aggressor === 'sell') { s.hakiValue += t.value; s.evidence++; }

    if (symbols.size && !symbols.has(t.symbol)) continue;
    if (boards.size && !boards.has(t.board)) continue;
    if (t.value < minValue) continue;
    matched++;
    // Simpan hanya sebanyak limit, ambil yang TERAKHIR — jendela bergulir, supaya
    // rentang seharian tidak menumpuk ratusan ribu objek di memori.
    matches.push(t);
    if (matches.length > limit) matches.shift();
  }

  for (const s of summaries.values()) {
    const total = s.hakaValue + s.hakiValue;
    s.hakaPct = s.evidence >= MIN_EVIDENCE && total > 0 ? (s.hakaValue / total) * 100 : -1;
  }

  return {
    date: q.date,
    from,
    to,
    scanned,
    matched,
    trades: matches.reverse(),
    truncated: matched > matches.length,
    symbols: [...summaries.values()].sort((a, b) => b.value - a.value).slice(0, 60),
    archived: lines.length > 0,
  };
}

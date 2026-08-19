import type { OrderBooks } from './orderbook.js';

/**
 * Narasi kejadian orderbook.
 *
 * Yang membuat ini tidak ada di aplikasi sekuritas bukan datanya, tapi
 * **pengawinannya**: perubahan tembok (OB2) dicocokkan dengan transaksi nyata di harga
 * yang sama (LT). Tanpa itu, tembok yang lenyap dan tembok yang habis dimakan terlihat
 * persis sama — padahal artinya berlawanan.
 *
 *   tembok hilang + ada transaksi sebesar itu   → benar-benar dimakan, level jebol
 *   tembok hilang + nyaris tanpa transaksi      → ditarik, temboknya cuma pajangan
 *
 * Ambangnya relatif terhadap buku emiten itu sendiri, bukan angka mutlak: 5.000 lot itu
 * tembok raksasa di emiten sepi dan debu di BBCA.
 */

export type JenisKejadian = 'spoof' | 'jebol' | 'absorpsi' | 'tembok';

export interface Kejadian {
  ts: number;
  symbol: string;
  jenis: JenisKejadian;
  price: number;
  sisi: 'bid' | 'ask';
  lot: number;
  teks: string;
}

interface Snapshot { bid: Map<number, number>; ask: Map<number, number> }

/** Tembok dianggap besar kalau setidaknya sekian kali median tingkat di buku itu. */
const KELIPATAN_BESAR = 3;
/** Tembok BARU dituntut lebih besar lagi: pemasangan terjadi terus-menerus, dan yang
 *  layak diberitakan cuma yang benar-benar mencolok. */
const KELIPATAN_TEMBOK_BARU = 6;
/** Di bawah ini tidak menarik apa pun emitennya — mencegah banjir kejadian receh. */
const LOT_MINIMUM = 500;
/** Berapa bagian tembok harus lenyap sebelum dianggap kejadian. */
const SUSUT_MIN = 0.6;
/** Transaksi di bawah bagian ini dari yang lenyap = ditarik, bukan dimakan. */
const AMBANG_SPOOF = 0.25;
/** Di atas ini, lenyapnya memang karena dihajar transaksi. */
const AMBANG_JEBOL = 0.6;

/** Jarak antar-potret. Tembok ditarik atau dijebol dalam hitungan puluhan detik, bukan
 *  dua detik — membandingkan potret 2 detik menghasilkan nol kejadian karena nyaris tidak
 *  ada tembok yang lenyap secepat itu. */
export const JEDA_PINDAI_MS = 10_000;
/** Satu tingkat tidak dilaporkan lagi selama ini, supaya tembok yang berkedip-kedip
 *  tidak membanjiri narasi dan menenggelamkan kejadian yang benar-benar penting. */
const DINGIN_MS = 90_000;

export class EventLog {
  private terakhir = new Map<string, Snapshot>();
  private daftar: Kejadian[] = [];
  private dingin = new Map<string, number>();
  private max: number;

  constructor(max = 300) { this.max = max; }

  /** true kalau tingkat ini baru saja dilaporkan — dipakai untuk semua jenis kejadian. */
  private masihDingin(symbol: string, price: number, jenis: JenisKejadian, now: number) {
    const kunci = `${symbol}@${price}@${jenis}`;
    const t = this.dingin.get(kunci) ?? 0;
    if (now - t < DINGIN_MS) return true;
    this.dingin.set(kunci, now);
    return false;
  }

  list(limit = 60, symbol?: string): Kejadian[] {
    const src = symbol ? this.daftar.filter((k) => k.symbol === symbol) : this.daftar;
    return src.slice(-limit).reverse();
  }

  /**
   * Bandingkan buku sekarang dengan potret sebelumnya.
   * `traded` = lot yang benar-benar bertransaksi per harga sejak pemeriksaan terakhir.
   */
  scan(books: OrderBooks, traded: Map<string, Map<number, number>>, now = Date.now()) {
    for (const code of books.codes()) {
      const v = books.get(code, 40);
      if (!v) continue;
      const kini: Snapshot = {
        bid: new Map(v.bid.map((x) => [x.price, x.lot])),
        ask: new Map(v.ask.map((x) => [x.price, x.lot])),
      };
      const lalu = this.terakhir.get(code);
      this.terakhir.set(code, kini);
      if (!lalu) continue;   // potret pertama cuma jadi pembanding

      const semua = [...kini.bid.values(), ...kini.ask.values()].sort((a, b) => a - b);
      if (semua.length < 5) continue;
      const median = semua[Math.floor(semua.length / 2)] || 1;
      const besar = Math.max(LOT_MINIMUM, median * KELIPATAN_BESAR);
      const trx = traded.get(code);

      // Batas kedalaman yang MASIH terlihat. Kita cuma memegang 40 tingkat teratas, jadi
      // saat harga bergerak, tingkat yang tergeser keluar jendela terlihat persis seperti
      // tembok yang lenyap — dan dilaporkan sebagai "ditarik" padahal cuma tidak terlihat.
      // Gejalanya kentara: banjir kejadian bertuliskan "cuma 0 lot bertransaksi".
      const bidTerdalam = Math.min(...kini.bid.keys());
      const askTerdalam = Math.max(...kini.ask.keys());

      for (const sisi of ['bid', 'ask'] as const) {
        for (const [price, lotLalu] of lalu[sisi]) {
          if (lotLalu < besar) continue;
          // Di luar jendela = tidak diketahui, bukan hilang.
          if (sisi === 'bid' && price < bidTerdalam) continue;
          if (sisi === 'ask' && price > askTerdalam) continue;
          const lotKini = kini[sisi].get(price) ?? 0;
          const susut = lotLalu - lotKini;
          if (susut < lotLalu * SUSUT_MIN) continue;

          const kena = trx?.get(price) ?? 0;
          const rasio = susut > 0 ? kena / susut : 0;
          if (rasio >= AMBANG_JEBOL) {
            if (this.masihDingin(code, price, 'jebol', now)) continue;
            this.tambah({ ts: now, symbol: code, jenis: 'jebol', price, sisi, lot: susut,
              teks: `tembok ${sisi === 'ask' ? 'jual' : 'beli'} ${fmt(lotLalu)} lot di ${fmt(price)} jebol — dihajar ${fmt(kena)} lot` });
          } else if (rasio < AMBANG_SPOOF) {
            if (this.masihDingin(code, price, 'spoof', now)) continue;
            this.tambah({ ts: now, symbol: code, jenis: 'spoof', price, sisi, lot: susut,
              teks: `tembok ${sisi === 'ask' ? 'jual' : 'beli'} ${fmt(lotLalu)} lot di ${fmt(price)} ditarik — cuma ${fmt(kena)} lot bertransaksi` });
          }
        }

        // Absorpsi: tembok yang sudah dimakan melebihi ukuran terbesarnya sendiri tapi
        // masih berdiri. Artinya ia diisi ulang terus — ada yang sengaja menahan di situ.
        // Ini dipindai untuk semua emiten yang dilanggan, bukan cuma yang sedang dibuka,
        // karena kejadiannya tidak menunggu kita melihat.
        for (const [price, lotKini] of kini[sisi]) {
          if (lotKini < besar) continue;
          const st = books.statAt(code, price);
          if (!st || st.isiUlang < 3 || st.dimakan < st.puncak) continue;
          this.catatAbsorpsi(code, price, sisi, st.dimakan, st.isiUlang, now);
        }

        // Tembok baru yang muncul mendadak — niat yang baru dipasang, layak diketahui
        // justru karena belum teruji.
        for (const [price, lotKini] of kini[sisi]) {
          if (lotKini < Math.max(LOT_MINIMUM, median * KELIPATAN_TEMBOK_BARU)) continue;
          const lotLalu = lalu[sisi].get(price) ?? 0;
          if (lotLalu >= lotKini * 0.5) continue;
          if (this.masihDingin(code, price, 'tembok', now)) continue;
          this.tambah({ ts: now, symbol: code, jenis: 'tembok', price, sisi, lot: lotKini,
            teks: `tembok ${sisi === 'ask' ? 'jual' : 'beli'} ${fmt(lotKini)} lot dipasang di ${fmt(price)}` });
        }
      }
    }
  }

  /** Absorpsi datang dari riwayat tingkat, bukan dari perbandingan potret — jadi
   *  dilaporkan terpisah dan hanya sekali per tingkat selama masih berlaku. */
  private sudahAbsorpsi = new Set<string>();
  catatAbsorpsi(symbol: string, price: number, sisi: 'bid' | 'ask', dimakan: number, isiUlang: number, now = Date.now()) {
    // Tanpa batas bawah, tingkat receh yang kebetulan diisi ulang tiga kali ikut
    // terberitakan ("419 lot diserap") dan menenggelamkan yang sungguhan.
    if (dimakan < LOT_MINIMUM) return;
    const kunci = `${symbol}@${price}`;
    if (this.sudahAbsorpsi.has(kunci)) return;
    this.sudahAbsorpsi.add(kunci);
    this.tambah({ ts: now, symbol, jenis: 'absorpsi', price, sisi, lot: dimakan,
      teks: `${fmt(dimakan)} lot diserap di ${fmt(price)} — tembok ${sisi === 'ask' ? 'jual' : 'beli'} diisi ulang ${isiUlang}× dan masih berdiri` });
  }

  private tambah(k: Kejadian) {
    this.daftar.push(k);
    if (this.daftar.length > this.max) this.daftar.splice(0, this.daftar.length - this.max);
  }

  /** Ganti hari: potret dan penanda absorpsi tidak boleh terbawa. */
  reset() { this.terakhir.clear(); this.daftar = []; this.sudahAbsorpsi.clear(); this.dingin.clear(); }
}

const fmt = (v: number) => v.toLocaleString('id-ID');

/**
 * Buku order per emiten dari feed OB2.
 *
 * Format dipecahkan 19 Agu 2026 dari frame nyata (bukan dari dokumen — dokumen SSSAHAM
 * hanya menyebut "perlu analisis lebih lanjut"):
 *
 *   INIT    { BUY: [[harga, lot], …], SELL: [[harga, lot], …], headinfo: "C|U|…" }
 *   UPDATE  { recinfo: "C|U|INET|RG|…|:|284|286|…|;|<perubahan>|X|1" }
 *
 * Bagian setelah `;` adalah daftar tingkat yang BERUBAH, tiga angka per tingkat:
 * `harga | lotBeli | lotJual`. Yang bukan nol menentukan sisinya; dua-duanya nol
 * berarti tingkat itu kosong. Dicocokkan terhadap INIT: SELL[0]=[286,26017] menjadi
 * 25911 dan BUY[0]=[284,28116] menjadi 28118 pada frame berikutnya — cocok.
 *
 * Bagian setelah `:` memuat harga bid dan ask terbaik; indeks 15/16 memuat lotnya.
 * Itu dipakai sebagai pemeriksa silang, bukan sumber utama — kalau keduanya berselisih,
 * yang salah hampir pasti pembacaan kita, dan lebih baik ketahuan.
 */

export interface BookLevel { price: number; lot: number }

/**
 * Riwayat satu tingkat harga sejak kita mulai melanggan. Inilah yang tidak dimiliki
 * aplikasi sekuritas: mereka menampilkan ukuran tembok SEKARANG, bukan berapa kali ia
 * sudah dimakan dan diisi ulang.
 *
 * `dimakan` menjumlahkan setiap penyusutan, `isiUlang` menghitung setiap penambahan
 * pada tingkat yang sudah ada. Tembok yang dimakan 96 ribu lot lalu diisi ulang 12 kali
 * dan masih berdiri bukan resistance biasa — ada yang sengaja menahan di situ.
 */
export interface LevelStat {
  /** Total lot yang menyusut dari tingkat ini (dimakan atau ditarik). */
  dimakan: number;
  /** Berapa kali tingkat ini bertambah setelah sebelumnya ada. */
  isiUlang: number;
  /** Ukuran terbesar yang pernah terlihat. */
  puncak: number;
  /** Sisi tempat riwayat ini terjadi saat terakhir diperbarui. */
  sisi: 'bid' | 'ask';
}

export interface BookView {
  code: string;
  /** Bid tertinggi lebih dulu. */
  bid: BookLevel[];
  /** Ask terendah lebih dulu. */
  ask: BookLevel[];
  spread: number | null;
  /** Selisih bid-ask dalam persen terhadap bid terbaik — ongkos masuk-keluar. */
  spreadPct: number | null;
  updatedAt: number;
  /** Berapa frame perubahan sudah diterapkan sejak buku dibangun. */
  updates: number;
}

/** Satu emiten. Harga disimpan di Map supaya perubahan satu tingkat tidak menuntut
 *  menggeser seluruh larik. */
class Book {
  bid = new Map<number, number>();
  ask = new Map<number, number>();
  updatedAt = 0;
  updates = 0;
  ready = false;
  /** Kapan buku ini pertama terbentuk — batas cakupan riwayat tingkatnya. */
  sejak = 0;

  init(buy: [number, number][], sell: [number, number][], ts: number) {
    this.bid.clear(); this.ask.clear();
    for (const [p, l] of buy) if (l > 0) this.bid.set(p, l);
    for (const [p, l] of sell) if (l > 0) this.ask.set(p, l);
    this.updatedAt = ts; this.updates = 0;
    if (!this.ready) this.sejak = ts;   // langganan ulang tidak mereset cakupan riwayat
    this.ready = true;
  }

  stat = new Map<number, LevelStat>();

  /** Catat perubahan ukuran satu tingkat. Menyusut = dimakan atau ditarik; bertambah
   *  pada tingkat yang sudah ada = diisi ulang. Keduanya tidak terlihat di aplikasi
   *  sekuritas, dan justru itu yang membedakan tembok sungguhan dari tembok pajangan. */
  private catat(price: number, lama: number, baru: number, sisi: 'bid' | 'ask') {
    let s = this.stat.get(price);
    if (!s) { s = { dimakan: 0, isiUlang: 0, puncak: 0, sisi }; this.stat.set(price, s); }
    s.sisi = sisi;
    if (baru > s.puncak) s.puncak = baru;
    if (lama > 0 && baru < lama) s.dimakan += lama - baru;
    else if (lama > 0 && baru > lama) s.isiUlang++;
  }

  /** Terapkan satu tingkat yang berubah. Lot 0 di kedua sisi = tingkat dihapus. */
  private set(price: number, lotBeli: number, lotJual: number) {
    if (lotBeli > 0) {
      this.catat(price, this.bid.get(price) ?? 0, lotBeli, 'bid');
      this.bid.set(price, lotBeli); this.ask.delete(price);
    } else if (lotJual > 0) {
      this.catat(price, this.ask.get(price) ?? 0, lotJual, 'ask');
      this.ask.set(price, lotJual); this.bid.delete(price);
    } else {
      const lama = this.bid.get(price) ?? this.ask.get(price) ?? 0;
      if (lama > 0) this.catat(price, lama, 0, this.bid.has(price) ? 'bid' : 'ask');
      this.bid.delete(price); this.ask.delete(price);
    }
  }

  update(recinfo: string, ts: number) {
    const potong = recinfo.indexOf(';');
    if (potong < 0) return;
    const bagian = recinfo.slice(potong + 1).split('|').filter((x) => x !== '');
    // Lewati bid/ask terbaik dan penanda huruf di depan; ambil dari angka pertama
    // setelah penanda 'P'. Kalau penandanya tidak ada, frame ini tidak dikenali —
    // diamkan daripada menebak dan merusak buku.
    const mulai = bagian.indexOf('P');
    if (mulai < 0) return;
    for (let i = mulai + 1; i + 2 < bagian.length; i += 3) {
      if (bagian[i] === 'X') break;
      const p = Number(bagian[i]), b = Number(bagian[i + 1]), s = Number(bagian[i + 2]);
      if (!Number.isFinite(p) || !Number.isFinite(b) || !Number.isFinite(s)) break;
      this.set(p, b, s);
    }
    this.updatedAt = ts; this.updates++;
  }

  view(code: string, depth: number): BookView {
    const bid = [...this.bid].sort((a, b) => b[0] - a[0]).slice(0, depth)
      .map(([price, lot]) => ({ price, lot }));
    const ask = [...this.ask].sort((a, b) => a[0] - b[0]).slice(0, depth)
      .map(([price, lot]) => ({ price, lot }));
    const spread = bid.length && ask.length ? ask[0].price - bid[0].price : null;
    return {
      code, bid, ask, spread,
      spreadPct: spread !== null && bid[0].price > 0 ? (spread / bid[0].price) * 100 : null,
      updatedAt: this.updatedAt, updates: this.updates,
    };
  }
}

export class OrderBooks {
  private books = new Map<string, Book>();

  /** `payload` = isi `data.data` frame OB2, sudah berupa objek atau string JSON. */
  feed(code: string, payload: unknown, ts = Date.now()) {
    let o: any = payload;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return; } }
    if (!o || typeof o !== 'object') return;
    let b = this.books.get(code);
    if (!b) { b = new Book(); this.books.set(code, b); }
    if (o.subcmd === 'INIT' && Array.isArray(o.BUY) && Array.isArray(o.SELL)) {
      b.init(o.BUY, o.SELL, ts);
    } else if (typeof o.recinfo === 'string' && b.ready) {
      // Sebelum INIT tiba, perubahan tidak bisa diterapkan ke apa pun — dibuang, bukan
      // dipakai membangun buku separuh jadi yang tampak lengkap padahal bolong.
      b.update(o.recinfo, ts);
    }
  }

  get(code: string, depth = 10): BookView | null {
    const b = this.books.get(code);
    return b?.ready ? b.view(code, depth) : null;
  }

  /** Ukuran tergeletak sekarang di satu harga, apa pun sisinya. */
  sizeAt(code: string, price: number): { lot: number; sisi: 'bid' | 'ask' } | null {
    const b = this.books.get(code);
    if (!b?.ready) return null;
    const d = b.bid.get(price);
    if (d !== undefined) return { lot: d, sisi: 'bid' };
    const s = b.ask.get(price);
    if (s !== undefined) return { lot: s, sisi: 'ask' };
    return null;
  }

  statAt(code: string, price: number): LevelStat | null {
    return this.books.get(code)?.stat.get(price) ?? null;
  }

  /** Sejak kapan buku emiten ini diamati — penting karena `dimakan`/`isiUlang` hanya
   *  mencakup sejak langganan dimulai, sementara footprint mencakup sejak pembukaan.
   *  Membandingkan keduanya tanpa menyebut beda cakupan ini akan menyesatkan. */
  sejak(code: string): number | null {
    const b = this.books.get(code);
    return b?.ready ? b.sejak : null;
  }

  get size() { return this.books.size; }
  codes() { return [...this.books.keys()]; }
}

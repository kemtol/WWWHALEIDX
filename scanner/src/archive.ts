import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';

/** Tanggal bursa (WIB) sebagai `YYYY-MM-DD`.
 *  Dihitung eksplisit, tidak mengandalkan zona waktu mesin — supaya arsip tetap
 *  terpotong pada batas hari bursa walau server dijalankan di zona lain. */
export function wibDateStr(d = new Date()): string {
  const wib = new Date(d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60_000);
  const mm = String(wib.getMonth() + 1).padStart(2, '0');
  const dd = String(wib.getDate()).padStart(2, '0');
  return `${wib.getFullYear()}-${mm}-${dd}`;
}

/**
 * Epoch ms dari jam bursa `HHMMSS` pada tanggal `YYYY-MM-DD`, keduanya WIB.
 *
 * Dibutuhkan karena `parseTrade` menyetel `ts` ke waktu TERIMA — benar untuk feed live,
 * tapi salah untuk transaksi yang dibaca dari arsip: semuanya akan bertimestamp "sekarang",
 * sehingga jendela bergulir (burst, tekanan) menganggap seluruh hari baru saja terjadi.
 */
export function wibTimestamp(date: string, hhmmss: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const hh = Number(hhmmss.slice(0, 2));
  const mi = Number(hhmmss.slice(2, 4));
  const ss = Number(hhmmss.slice(4, 6));
  // WIB = UTC+7, dihitung eksplisit supaya tidak bergantung zona waktu mesin.
  return Date.UTC(y, mo - 1, d, hh - 7, mi, ss);
}

/** Arsip hari berjalan ditulis mentah (`.txt`) karena terus di-append; hari yang sudah
 *  lewat dipadatkan jadi `.txt.gz`. Keduanya dikenali di sini. */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.txt(\.gz)?$/;

/**
 * Arsip transaksi mentah, satu file per hari bursa: `logs/lt/YYYY-MM-DD.txt`,
 * satu payload pipe LT per baris — apa adanya, tanpa diolah.
 *
 * Kenapa payload mentah dan bukan JSON: lossless (field yang artinya belum
 * ketahuan ikut tersimpan, jadi bisa dibedah nanti) dan hemat — 72 byte per
 * transaksi, sekitar 25 MB per hari bursa penuh.
 *
 * Bedanya dengan `frames.jsonl`: file itu memotong diri sendiri di 20 MB, jadi
 * tidak pernah memuat satu hari utuh. Arsip ini tidak dipotong; yang dibatasi
 * adalah umurnya (retensi harian).
 */
export class TradeArchive {
  private dir: string;
  private date = '';
  private path = '';
  private buf: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private retentionDays: number;
  /** Jumlah baris yang benar-benar sampai ke disk sejak proses mulai. */
  written = 0;
  lastError: string | null = null;
  /** Jam transaksi pertama per tanggal. Membaca ini dari arsip padat menuntut membuka
   *  seluruh file, sementara panel detail memintanya tiap kali dibuka. */
  private startCache = new Map<string, string>();

  constructor(logDir: string, retentionDays = 30) {
    this.dir = join(logDir, 'lt');
    this.retentionDays = retentionDays;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Catat satu payload LT. Ditumpuk dulu, bukan langsung ditulis: satu hari
   *  bursa bisa ratusan ribu transaksi, dan satu syscall per transaksi memboroskan
   *  CPU tanpa manfaat karena kita tidak butuh arsipnya real-time. */
  write(payload: string) {
    this.buf.push(payload);
    if (this.buf.length >= 512) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 2_000);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buf.length) return;
    const lines = this.buf;
    this.buf = [];
    try {
      const today = wibDateStr();
      if (today !== this.date) {
        const previous = this.date;
        this.date = today;
        this.path = join(this.dir, `${today}.txt`);
        // Hari yang baru saja lewat tidak akan di-append lagi, jadi aman dipadatkan.
        if (previous) this.compress(previous);
        this.compressBacklog();
        this.prune();
      }
      appendFileSync(this.path, lines.join('\n') + '\n');
      this.written += lines.length;
      this.lastError = null;
    } catch (e) {
      // Arsip gagal tidak boleh menjatuhkan scanner — feed live lebih penting.
      // Barisnya dibuang, bukan ditumpuk, supaya memori tidak tumbuh tanpa batas.
      this.lastError = (e as Error).message;
    }
  }

  /**
   * Padatkan arsip satu hari menjadi `.txt.gz` dan hapus yang mentah.
   *
   * Payload pipe sangat berulang, jadi gzip memangkasnya ~5,4× (terukur pada 19,7 MB
   * data 14 Agu 2026 → 3,6 MB). Itu penting karena laju sebenarnya ~77 MB per hari
   * bursa penuh, tiga kali lipat perkiraan awal.
   *
   * Hari BERJALAN tidak pernah dipadatkan — file-nya masih di-append terus.
   */
  compress(date: string): boolean {
    if (date === wibDateStr()) return false;
    const raw = join(this.dir, `${date}.txt`);
    const gz = join(this.dir, `${date}.txt.gz`);
    try {
      if (!existsSync(raw)) return false;
      // Tulis dulu, hapus belakangan: kalau proses mati di tengah, yang hilang cuma
      // hasil setengah jadi, bukan arsipnya.
      writeFileSync(gz, gzipSync(readFileSync(raw), { level: 6 }));
      unlinkSync(raw);
      return true;
    } catch {
      try { if (existsSync(gz) && existsSync(raw)) unlinkSync(gz); } catch { /* */ }
      return false;
    }
  }

  /** Padatkan semua hari lampau yang masih tersimpan mentah — mis. arsip yang dibuat
   *  sebelum kompresi ada, atau hari yang terlewat karena proses sempat mati. */
  compressBacklog(): string[] {
    const done: string[] = [];
    const today = wibDateStr();
    try {
      for (const name of readdirSync(this.dir)) {
        const m = /^(\d{4}-\d{2}-\d{2})\.txt$/.exec(name);
        if (m && m[1] !== today && this.compress(m[1])) done.push(m[1]);
      }
    } catch { /* bukan alasan berhenti mengarsip */ }
    return done;
  }

  /** Buang arsip yang lebih tua dari masa retensi. Nama file `YYYY-MM-DD`
   *  urut secara leksikografis, jadi cukup dibandingkan sebagai string. */
  private prune() {
    try {
      const cutoff = wibDateStr(new Date(Date.now() - this.retentionDays * 86_400_000));
      for (const name of readdirSync(this.dir)) {
        const m = FILE_RE.exec(name);
        if (m && m[1] < cutoff) unlinkSync(join(this.dir, name));
      }
    } catch { /* retensi gagal bukan alasan berhenti mengarsip */ }
  }

  /** Tanggal yang tersedia di arsip, terbaru dulu. */
  days(): string[] {
    try {
      return readdirSync(this.dir)
        .map((n) => FILE_RE.exec(n)?.[1])
        .filter((d): d is string => !!d)
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  /** Baca satu hari arsip. Baris yang belum ter-flush ikut disertakan kalau
   *  tanggalnya cocok, supaya transaksi beberapa detik terakhir tidak hilang
   *  dari hasil query. */
  readDay(date: string): string[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    let lines: string[] = [];
    try {
      lines = readFileSync(join(this.dir, `${date}.txt`), 'utf8').split('\n');
    } catch {
      // Belum tentu tidak ada — hari lampau tersimpan padat.
      try {
        lines = gunzipSync(readFileSync(join(this.dir, `${date}.txt.gz`))).toString('utf8').split('\n');
      } catch { /* hari itu memang tidak ada arsipnya */ }
    }
    if (date === this.date && this.buf.length) lines = lines.concat(this.buf);
    return lines.filter(Boolean);
  }

  /** Ukuran arsip per hari (bentuk apa pun yang tersimpan), untuk ditampilkan di UI. */
  sizeOf(date: string): number {
    for (const name of [`${date}.txt`, `${date}.txt.gz`]) {
      try { return statSync(join(this.dir, name)).size; } catch { /* coba bentuk lain */ }
    }
    return 0;
  }

  /** Apakah hari itu tersimpan dalam bentuk padat. */
  isCompressed(date: string): boolean {
    return existsSync(join(this.dir, `${date}.txt.gz`));
  }

  /**
   * Jam bursa (`HHMMSS`) dari transaksi PERTAMA yang terekam hari itu, atau null
   * kalau arsipnya kosong.
   *
   * Ini penentu apakah angka kumulatif (delta, footprint, volume) sah disebut
   * "sejak pembukaan". Kalau scanner baru login jam 11:45, semuanya sebenarnya
   * "sejak 11:45" — dan menampilkannya sebagai sejak pembukaan itu salah, bukan
   * sekadar kurang lengkap.
   *
   * Hanya awal file yang dibaca, bukan seluruhnya: ini dipanggil tiap kali panel
   * detail dibuka, sementara arsip satu hari bisa puluhan MB.
   */
  startTime(date: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const cached = this.startCache.get(date);
    if (cached !== undefined) return cached;

    let head = '';
    try {
      const fd = openSync(join(this.dir, `${date}.txt`), 'r');
      try {
        const buf = Buffer.alloc(256);
        const n = readSync(fd, buf, 0, 256, 0);
        head = buf.subarray(0, n).toString('utf8');
      } finally { closeSync(fd); }
    } catch {
      try {
        // Bentuk padat tidak bisa dibaca sebagian, jadi terpaksa dibuka utuh. Hasilnya
        // di-cache karena hari lampau tidak berubah lagi, sementara panel detail
        // memanggil ini tiap kali dibuka.
        const all = gunzipSync(readFileSync(join(this.dir, `${date}.txt.gz`))).toString('utf8');
        head = all.slice(0, 256);
      } catch {
        // Belum ada filenya; baris yang masih di buffer tetap bisa menjawab.
        if (date === this.date && this.buf.length) head = this.buf[0];
      }
    }
    const line = head.split('\n')[0];
    const time = line?.split('|')[1];
    const result = /^\d{6}$/.test(time ?? '') ? time! : null;
    // Hari berjalan masih tumbuh, tapi baris PERTAMA-nya tidak berubah lagi begitu ada.
    if (result) this.startCache.set(date, result);
    return result;
  }
}

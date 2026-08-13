import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.txt$/;

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
        this.date = today;
        this.path = join(this.dir, `${today}.txt`);
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
    } catch { /* hari itu tidak ada arsipnya */ }
    if (date === this.date && this.buf.length) lines = lines.concat(this.buf);
    return lines.filter(Boolean);
  }

  /** Ukuran arsip per hari, untuk ditampilkan di UI. */
  sizeOf(date: string): number {
    try { return statSync(join(this.dir, `${date}.txt`)).size; } catch { return 0; }
  }
}

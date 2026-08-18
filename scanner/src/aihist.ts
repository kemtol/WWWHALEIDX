import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiResult, AiUsage } from './ai.js';

/**
 * Riwayat analisa AI di disk. Alasannya bukan kerapian: satu panggilan makan 2-3 menit
 * dan uang, jadi jawabannya tidak boleh hilang hanya karena app di-restart atau tab
 * ditutup. Yang lebih penting, riwayat inilah yang memungkinkan menilai apakah
 * rekomendasi kemarin ternyata benar — mustahil kalau hasilnya menguap.
 *
 * Dua berkas terpisah, sengaja:
 *   history.jsonl   ringkasan + hasil (±2 KB/entri) — dibaca UTUH tiap buka daftar
 *   p/<id>.txt      prompt (±12 KB/entri) — hanya dibaca kalau diminta
 * Kalau prompt ikut di JSONL, membuka daftar berarti mem-parse belasan MB tanpa alasan.
 */

const MAX_ENTRIES = 500;

/** Satu giliran percakapan lanjutan SETELAH analisa awal. Analisa awalnya sendiri tidak
 *  disimpan di sini — ia sudah ada terstruktur di `result`, dan menyalinnya sebagai teks
 *  berarti dua sumber kebenaran untuk isi yang sama. */
export interface AiTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface AiEntry {
  /** `YYYY-MM-DDTHH-MM-SS` waktu WIB — sekaligus urutan kronologisnya. */
  id: string;
  ts: number;
  /** Tanggal data yang dianalisa (bisa beda dari `ts` kalau memeriksa arsip lampau). */
  date: string;
  count: number;
  tookMs: number;
  usage: AiUsage;
  result: AiResult;
  /** Tanya-jawab lanjutan. Entri lama tidak punya field ini — perlakukan sebagai []. */
  turns?: AiTurn[];
}

/** Baris daftar — tanpa `result` penuh, cukup untuk kolom kiri. */
export interface AiSummary {
  id: string;
  ts: number;
  date: string;
  picks: number;
  symbols: string[];
  model: string;
}

export class AiHistory {
  private dir: string;
  private path: string;
  private promptDir: string;

  constructor(logDir: string) {
    this.dir = join(logDir, 'ai');
    this.path = join(this.dir, 'history.jsonl');
    this.promptDir = join(this.dir, 'p');
    mkdirSync(this.promptDir, { recursive: true });
  }

  private lines(): string[] {
    try {
      return readFileSync(this.path, 'utf8').split('\n').filter((l) => l.trim());
    } catch {
      return [];   // belum ada riwayat
    }
  }

  /** Simpan satu hasil. Gagal menyimpan TIDAK boleh menjatuhkan panggilan yang sudah
   *  berhasil dan sudah dibayar — jawabannya tetap dikirim ke halaman. */
  save(entry: AiEntry, prompt: string): void {
    try {
      appendFileSync(this.path, JSON.stringify(entry) + '\n');
      writeFileSync(join(this.promptDir, `${entry.id}.txt`), prompt);
      this.trim();
    } catch { /* diabaikan dengan sengaja */ }
  }

  /** Buang entri terlama kalau sudah lewat batas. Berkas prompt-nya dibiarkan —
   *  menghapusnya menuntut readdir tiap simpan, dan ukurannya tidak seberapa. */
  private trim(): void {
    const ls = this.lines();
    if (ls.length <= MAX_ENTRIES) return;
    writeFileSync(this.path, ls.slice(-MAX_ENTRIES).join('\n') + '\n');
  }

  /** Terbaru dulu — itu yang hampir selalu dicari. */
  list(): AiSummary[] {
    const out: AiSummary[] = [];
    for (const l of this.lines()) {
      try {
        const e = JSON.parse(l) as AiEntry;
        out.push({
          id: e.id, ts: e.ts, date: e.date,
          picks: e.result?.picks?.length ?? 0,
          symbols: (e.result?.picks ?? []).map((p) => p.symbol),
          model: e.usage?.model ?? '',
        });
      } catch { /* baris rusak dilewati, bukan alasan menggagalkan seluruh daftar */ }
    }
    // Diurutkan dari `ts`, bukan dari urutan baris. Penulisan memang selalu append
    // kronologis, tapi bersandar pada itu berarti satu berkas yang pernah disunting
    // tangan menghasilkan daftar yang urutannya salah tanpa gejala lain.
    return out.sort((a, b) => b.ts - a.ts);
  }

  /** Tambah giliran percakapan ke entri yang sudah ada.
   *
   *  Barisnya ditulis ulang di tempat, bukan di-append sebagai baris baru: satu id harus
   *  tetap satu baris, kalau tidak `get()` mengembalikan versi yang mana pun ditemukan
   *  lebih dulu dan percakapannya terpecah. Menulis ulang seluruh berkas untuk 500 entri
   *  (±1 MB) jauh lebih murah daripada bug seperti itu. */
  appendTurns(id: string, turns: AiTurn[]): boolean {
    const ls = this.lines();
    let found = false;
    const out = ls.map((l) => {
      try {
        const e = JSON.parse(l) as AiEntry;
        if (e.id !== id) return l;
        found = true;
        return JSON.stringify({ ...e, turns: [...(e.turns ?? []), ...turns] });
      } catch {
        return l;   // baris rusak dibiarkan apa adanya, jangan sampai ikut terhapus
      }
    });
    if (!found) return false;
    try { writeFileSync(this.path, out.join('\n') + '\n'); return true; }
    catch { return false; }
  }

  get(id: string): (AiEntry & { prompt: string | null }) | null {
    for (const l of this.lines()) {
      try {
        const e = JSON.parse(l) as AiEntry;
        if (e.id !== id) continue;
        let prompt: string | null = null;
        // `id` sudah dicocokkan dengan entri yang benar-benar ada di riwayat, jadi tidak
        // bisa dipakai menjangkau berkas di luar direktori ini.
        try { prompt = readFileSync(join(this.promptDir, `${id}.txt`), 'utf8'); } catch { /* prompt lama sudah tidak ada */ }
        return { ...e, prompt };
      } catch { /* lanjut */ }
    }
    return null;
  }
}

/** `YYYY-MM-DDTHH-MM-SS` waktu WIB. Dipakai sebagai id sekaligus kunci urut. */
export function aiEntryId(d = new Date()): string {
  const wib = new Date(d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${wib.getFullYear()}-${p(wib.getMonth() + 1)}-${p(wib.getDate())}`
    + `T${p(wib.getHours())}-${p(wib.getMinutes())}-${p(wib.getSeconds())}`;
}

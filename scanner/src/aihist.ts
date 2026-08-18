import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiResult, AiUsage } from './ai.js';

/**
 * Riwayat analisa AI di disk. **Satu hari = satu benang percakapan**, bukan satu entri
 * per klik tombol.
 *
 * Ini bukan soal kerapian. Kalau tiap klik memulai percakapan baru, model tidak tahu ia
 * pernah merekomendasikan DSSA pagi tadi — jadi saat DSSA hilang dari analisa siang, ia
 * diam saja dan pembacanya bertanya-tanya. Padahal HILANGNYA sebuah pick sering lebih
 * berguna daripada pick barunya. Dengan satu benang per hari, analisa siang melihat
 * rekomendasi paginya sendiri dan bisa menjelaskan apa yang berubah.
 *
 * Dua berkas terpisah, sengaja:
 *   history.jsonl        satu baris per HARI: seluruh item hari itu (±2-10 KB)
 *   p/<date>-<n>.txt     payload tiap analisa (±12 KB) — hanya dibaca saat menyusun
 *                        konteks atau saat penggunanya minta
 * Kalau payload ikut di JSONL, membuka daftar berarti mem-parse belasan MB tanpa alasan.
 */

const MAX_DAYS = 120;

/** Satu langkah dalam percakapan sehari. Analisa dan tanya-jawab hidup di deret yang
 *  sama supaya urutannya persis seperti yang terjadi — analisa pagi, tanya-jawab,
 *  analisa siang, tanya-jawab lagi. */
export type AiItem =
  | {
      kind: 'analysis';
      ts: number;
      count: number;
      tookMs: number;
      usage: AiUsage;
      result: AiResult;
      /** Nama berkas payload di `p/`, tanpa direktori. */
      promptRef: string;
    }
  | { kind: 'user'; ts: number; text: string }
  | { kind: 'assistant'; ts: number; text: string };

export interface AiThread {
  /** Tanggal `YYYY-MM-DD` — sekaligus id benangnya. */
  id: string;
  date: string;
  /** Kegiatan pertama dan terakhir hari itu. */
  ts: number;
  updated: number;
  items: AiItem[];
}

/** Baris daftar — tanpa isi penuh, cukup untuk kolom kiri. */
export interface AiSummary {
  id: string;
  date: string;
  ts: number;
  updated: number;
  /** Berapa kali tombol AI ditekan hari itu. */
  analyses: number;
  /** Berapa tanya-jawab lanjutan. */
  chats: number;
  /** Pick dari analisa TERAKHIR hari itu — yang paling relevan sekarang. */
  symbols: string[];
  model: string;
}

/** Bentuk lama: satu entri per klik, `result` tunggal + `turns[]`. Dibaca sekali lalu
 *  diubah ke bentuk benang supaya riwayat yang sudah ada tidak perlu dibuang. */
interface LegacyEntry {
  id: string; ts: number; date: string; count: number; tookMs: number;
  usage: AiUsage; result: AiResult;
  turns?: { role: 'user' | 'assistant'; text: string; ts: number }[];
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

  /** Seluruh benang, terlama dulu. Entri bentuk lama ikut dinaikkan ke bentuk benang di
   *  sini — hanya di memori; berkasnya baru berubah saat ada penulisan berikutnya. */
  private threads(): AiThread[] {
    const byDate = new Map<string, AiThread>();
    for (const l of this.lines()) {
      let raw: any;
      try { raw = JSON.parse(l); } catch { continue; }   // baris rusak dilewati

      if (Array.isArray(raw?.items)) {
        byDate.set(raw.id, raw as AiThread);
        continue;
      }
      // ---- bentuk lama -> benang
      const e = raw as LegacyEntry;
      if (!e?.date || !e?.result) continue;
      const items: AiItem[] = [{
        kind: 'analysis', ts: e.ts, count: e.count, tookMs: e.tookMs,
        usage: e.usage, result: e.result, promptRef: `${e.id}.txt`,
      }];
      for (const t of e.turns ?? []) items.push({ kind: t.role, ts: t.ts, text: t.text });
      const existing = byDate.get(e.date);
      if (existing) {
        existing.items.push(...items);
        existing.updated = Math.max(existing.updated, e.ts);
      } else {
        byDate.set(e.date, {
          id: e.date, date: e.date, ts: e.ts,
          updated: items[items.length - 1]?.ts ?? e.ts, items,
        });
      }
    }
    // Item diurutkan waktu: penggabungan beberapa entri lama ke satu hari bisa
    // menghasilkan urutan yang tidak kronologis.
    for (const t of byDate.values()) t.items.sort((a, b) => a.ts - b.ts);
    return [...byDate.values()].sort((a, b) => a.ts - b.ts);
  }

  private writeAll(threads: AiThread[]): boolean {
    try {
      const keep = threads.slice(-MAX_DAYS);
      writeFileSync(this.path, keep.map((t) => JSON.stringify(t)).join('\n') + '\n');
      return true;
    } catch {
      return false;   // gagal menyimpan tidak boleh menjatuhkan panggilan yang sudah dibayar
    }
  }

  /** Terbaru dulu — itu yang hampir selalu dicari. */
  list(): AiSummary[] {
    return this.threads().map((t) => {
      const analyses = t.items.filter((i) => i.kind === 'analysis') as Extract<AiItem, { kind: 'analysis' }>[];
      const last = analyses[analyses.length - 1];
      return {
        id: t.id, date: t.date, ts: t.ts, updated: t.updated,
        analyses: analyses.length,
        chats: t.items.filter((i) => i.kind === 'user').length,
        symbols: last?.result?.picks?.map((p) => p.symbol) ?? [],
        model: last?.usage?.model ?? '',
      };
    }).sort((a, b) => b.updated - a.updated);
  }

  get(date: string): AiThread | null {
    return this.threads().find((t) => t.id === date) ?? null;
  }

  /** Payload satu analisa. `ref` selalu berasal dari item yang memang ada di riwayat,
   *  jadi tidak bisa dipakai menjangkau berkas di luar direktori ini. */
  readPrompt(ref: string): string | null {
    if (!/^[\w.-]+\.txt$/.test(ref)) return null;
    try { return readFileSync(join(this.promptDir, ref), 'utf8'); } catch { return null; }
  }

  /** Tambah satu analisa ke benang hari itu, membuat benangnya kalau belum ada. */
  addAnalysis(
    date: string,
    a: { ts: number; count: number; tookMs: number; usage: AiUsage; result: AiResult },
    prompt: string,
  ): void {
    const threads = this.threads();
    let t = threads.find((x) => x.id === date);
    if (!t) {
      t = { id: date, date, ts: a.ts, updated: a.ts, items: [] };
      threads.push(t);
      threads.sort((x, y) => x.ts - y.ts);
    }
    const n = t.items.filter((i) => i.kind === 'analysis').length + 1;
    const promptRef = `${date}-${n}.txt`;
    try { writeFileSync(join(this.promptDir, promptRef), prompt); } catch { /* payload hilang, analisanya tetap tersimpan */ }
    t.items.push({ kind: 'analysis', ts: a.ts, count: a.count, tookMs: a.tookMs,
      usage: a.usage, result: a.result, promptRef });
    t.updated = a.ts;
    this.writeAll(threads);
  }

  /** Tambah tanya-jawab ke benang hari itu. */
  addTurns(date: string, turns: { role: 'user' | 'assistant'; text: string; ts: number }[]): boolean {
    const threads = this.threads();
    const t = threads.find((x) => x.id === date);
    if (!t) return false;
    for (const x of turns) t.items.push({ kind: x.role, ts: x.ts, text: x.text });
    t.updated = turns[turns.length - 1]?.ts ?? t.updated;
    return this.writeAll(threads);
  }
}

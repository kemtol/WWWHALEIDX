/**
 * Pemanggil AI untuk rekomendasi scalping. Provider: DeepSeek (OpenAI-compatible).
 *
 * Kunci HANYA dibaca dari environment (`scanner/.env`, mode 0600, di-gitignore) —
 * jangan pernah menuliskannya ke kode, log, atau balasan API. Repo ini publik.
 *
 * Balasan model diminta JSON (`response_format: json_object`) mengikuti skema di
 * `prompts/scalp.md`. Tetap divalidasi di sini: model bisa saja mengirim JSON sah tapi
 * berbentuk lain, dan halaman tidak boleh menerima bentuk yang tidak dikenal.
 */

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
/** Model reasoning berpikir lama pada payload 20-an emiten: terukur 166 detik untuk
 *  20 kandidat di `deepseek-v4-pro` (12.843 token completion). Batasnya diberi margin
 *  lebar dari angka itu — gagal karena timeout jauh lebih menjengkelkan daripada
 *  menunggu, dan biayanya cuma di bawah $0,005 sekali panggil. */
const TIMEOUT_MS = 300_000;

export interface Pick {
  symbol: string;
  setup: string;
  keyakinan: number;
  entry: number;
  invalidasi: number;
  target: number;
  alasan: string;
  bukti: string[];
}

export interface AiResult {
  pasar: string;
  /** Hanya terisi pada analisa lanjutan: apa yang berubah sejak analisa sebelumnya di
   *  hari yang sama, terutama pick yang dikeluarkan beserta alasannya. */
  perubahan?: string;
  picks: Pick[];
  dihindari: { symbol: string; kenapa: string }[];
}

export interface AiUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Bagian prompt yang kena cache DeepSeek — jauh lebih murah. */
  cachedTokens: number;
}

export function aiConfigured() { return !!process.env.DEEPSEEK_API_KEY; }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** Harga di IDX selalu bilangan bulat rupiah. Model kadang mengarang pecahan
 *  (`deepseek-v4-flash` terpantau memberi entry 149,9) — itu harga yang tidak mungkin
 *  ada di papan, jadi jangan sampai tampil sebagai angka keputusan. */
const price = (v: unknown) => Math.round(num(v));

/** Ambil bentuk yang dikenal saja. Field asing dibuang, field hilang diberi nilai
 *  kosong — halaman tidak perlu menebak-nebak apa yang dikirim model. */
function normalize(raw: unknown): AiResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const picks = Array.isArray(o.picks) ? o.picks : [];
  const avoid = Array.isArray(o.dihindari) ? o.dihindari : [];
  return {
    pasar: str(o.pasar),
    ...(str(o.perubahan) ? { perubahan: str(o.perubahan) } : {}),
    picks: picks.slice(0, 5).map((p) => {
      const q = (p ?? {}) as Record<string, unknown>;
      return {
        symbol: str(q.symbol).toUpperCase(),
        setup: str(q.setup),
        keyakinan: Math.min(5, Math.max(1, Math.round(num(q.keyakinan)) || 1)),
        entry: price(q.entry),
        invalidasi: price(q.invalidasi),
        target: price(q.target),
        alasan: str(q.alasan),
        bukti: Array.isArray(q.bukti) ? q.bukti.map(str).filter(Boolean) : [],
      };
    }).filter((p) => p.symbol),
    dihindari: avoid.slice(0, 8).map((d) => {
      const q = (d ?? {}) as Record<string, unknown>;
      return { symbol: str(q.symbol).toUpperCase(), kenapa: str(q.kenapa) };
    }).filter((d) => d.symbol),
  };
}

export interface ChatMsg { role: 'user' | 'assistant'; content: string; }

/** Satu panggilan ke model. `json` = paksa balasan JSON (dipakai analisa awal);
 *  tanpa itu balasannya teks bebas (dipakai tanya-jawab lanjutan). */
async function call(messages: ChatMsg[], json: boolean): Promise<{ text: string; usage: AiUsage }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY belum diset (lihat scanner/.env.example)');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: ac.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        temperature: 0.3,
      }),
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(ac.signal.aborted
      ? `model tidak menjawab dalam ${TIMEOUT_MS / 1000} detik`
      : `gagal menghubungi DeepSeek: ${(e as Error).message}`);
  }
  clearTimeout(timer);

  const body = await res.json().catch(() => null) as any;
  if (!res.ok) {
    // Pesan server dipakai apa adanya — di situ ada sebab yang berguna (saldo habis,
    // kunci ditolak, rate limit). Kuncinya sendiri tidak pernah ikut di badan balasan.
    throw new Error(body?.error?.message ?? `DeepSeek menolak (HTTP ${res.status})`);
  }

  const choice = body?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('balasan model kosong');
  if (choice?.finish_reason === 'length') throw new Error('balasan model terpotong (limit token)');

  const u = body?.usage ?? {};
  return {
    text,
    usage: {
      model: body?.model ?? MODEL,
      promptTokens: num(u.prompt_tokens),
      completionTokens: num(u.completion_tokens),
      cachedTokens: num(u.prompt_cache_hit_tokens),
    },
  };
}

/** Analisa. `history` berisi percakapan hari itu sejauh ini (kosong = analisa pertama);
 *  `prompt` adalah giliran terakhir yang memuat data terbaru. */
export async function askAi(
  prompt: string,
  history: ChatMsg[] = [],
): Promise<{ result: AiResult; usage: AiUsage }> {
  const { text, usage } = await call([...history, { role: 'user', content: prompt }], true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('balasan model bukan JSON yang sah');
  }
  return { result: normalize(parsed), usage };
}

/** Tanya-jawab lanjutan atas analisa yang sudah ada. Balasannya teks bebas — memaksakan
 *  JSON di sini hanya akan membuat model menjawab pertanyaan terbuka dalam bentuk yang
 *  canggung. */
export async function chatAi(messages: ChatMsg[]): Promise<{ text: string; usage: AiUsage }> {
  return call(messages, false);
}

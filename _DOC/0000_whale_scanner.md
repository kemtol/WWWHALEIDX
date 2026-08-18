# PRD: IDX Whale Scanner

**Stack:** Node.js + TypeScript, UI browser lokal (`scanner/`)
**Target:** tool pribadi, jalan permanen di komputer sendiri — bukan produk yang di-deploy
ke server luar. Diakses via `https://whale.scanner.local` (auto-start lewat systemd
`--user` service), lihat [`scanner/README.md`](../scanner/README.md#jalan-otomatis--domain-lokal-httpswhalescannerlocal).

## 1. Tujuan

Pengguna tunggal tool ini adalah **scalper**. Pertanyaan yang harus bisa dijawab tool
ini setiap hari bursa: **"saham apa yang HARI INI potensial ditradingkan untuk target
1,5–2%?"** — bukan prediksi jangka panjang, bukan rekomendasi hold.

Dua cara tool ini menjawabnya (detail rencananya di bagian 5):

1. **Sinyal manual** — menampilkan transaksi beli agresif (HAKA) yang ramai, khususnya
   yang terjadi saat harga berada di **area penting** (VWAP, high/low hari ini,
   penutupan kemarin, angka bulat psikologis), dipisah dari derasnya seluruh transaksi
   bursa lewat filter nilai/burst/papan/jam.
2. **Rekomendasi AI** — satu tombol yang mengadu Claude vs Kimi vs DeepSeek dengan
   prompt identik untuk menganalisa running trade + OB2 hari ini dan memilih emiten
   yang layak di-scalp.

Batas yang tidak berubah sejak awal: ini **bukan sistem alert otomatis dan bukan
auto-trading**. Tool menyiapkan kandidat beserta buktinya; keputusan eksekusi tetap
di tangan pengguna.

## 2. Kenapa bukan Rust / TUI

Percobaan pertama pakai Rust + rencana UI terminal (Ratatui) — dokumen itu sudah dihapus
karena dua alasan:

1. **Implementasinya cacat sejak awal.** Subscribe ke feed `mi`/`LT` selalu dibalas
   `NOSERVICE` karena butuh sesi IPOT yang sudah login, dan rancangannya sama sekali
   tidak punya alur login. Baru ketemu solusinya setelah membedah frame WebSocket dari
   browser IPOT asli: **login QR lewat WebSocket** (lihat `scanner/README.md`).
2. **Tool ini cuma dipakai sendiri, lokal.** Overhead Rust (compile time, borrow checker,
   TUI event loop) tidak sepadan untuk skala ini. Browser lokal memberi sorting, filter,
   dan warna nyaris gratis — tanpa perlu membangun widget dari nol.

Kode Rust sudah dihapus total dari repo; riwayatnya masih ada di `git log` kalau perlu
ditengok kembali.

## 3. Cara kerja (ringkas)

Dua proses, dipisah supaya sesi IPOT tidak ikut mati tiap kali kode UI diubah:

```
IPOT WebSocket ──> COLLECTOR (src/collector.ts)
                     sesi, reconnect, peringatan login
                     │
                     ├──> logs/lt/YYYY-MM-DD.txt   arsip mentah, tahan restart app
                     │
                     └──(unix socket, src/bus.ts)──> APP (src/app.ts)
                                                       filters.ts  burst + HAKA/HAKI
                                                       symbol.ts   delta + footprint
                                                       market.ts   papan pasar (Papan)
                                                       history.ts  query arsip
                                                       server.ts   UI + /api/*
                                                          │
                                                       public/index.html
```

Collector sengaja tidak memuat UI maupun analitik: IPOT menolak token sesi yang
dipulihkan, jadi tiap restart proses pemegang koneksi menuntut scan QR ulang. App boleh
direstart sesering apa pun tanpa menyentuh sesi.

Detail protokol, format pipe LT yang terverifikasi, dan cara jalan — ada di
[`scanner/README.md`](../scanner/README.md), supaya tidak dobel dan gampang basi.

## 4. Fitur inti

- **Login QR** — scan dari HP (IPOT → Member Area → Security → Login to IPOT Web),
  tanpa endpoint HTTP terpisah, semua lewat satu WebSocket.
- **Live trade** — mengalir ke tabel begitu login berhasil, halaman otomatis pindah
  dari layar QR ke dashboard.
- **Filter transaksi** — emiten (watchlist), nilai minimum, lot minimum, papan
  (RG/NG/TN), rentang harga, rentang % perubahan, rentang % terhadap VWAP, jam, dan
  **burst** (N transaksi dalam T detik, jendela bergulir per emiten).
- **Sisi agresor per transaksi** — HAKA/HAKI dibaca langsung dari feed (posisi angka di
  field `[13]`/`[14]`), bukan ditebak. Cakupan 100% transaksi RG selama sesi berjalan;
  kosong hanya di lelang penutupan, di mana memang tidak ada agresor.
  Lihat `scanner/README.md`.
- **Tekanan HAKA/HAKI** — panel agregat per emiten, ditimbang nilai, dihitung dari sisi
  agresor feed (cakupan 100% nilai saat sesi berjalan, sebelumnya 16,8% dengan tick rule).
  Transaksi yang
  sisinya tidak disebutkan feed tetap **tidak ditebak** arahnya — prinsip lama yang tidak
  berubah, karena menebak lewat pewarisan arah terbukti membalik kesimpulan pada 28% emiten.
- **Peringatan belum login** — bursa buka tapi scanner tidak login = data hilang diam-diam.
  Sekarang ada notifikasi desktop, peringatan journal berkala, dan banner di layar QR
  berisi hitungan menit yang tidak terekam.
- **Arsip harian & riwayat** — setiap transaksi disimpan mentah per hari (~25 MB/hari
  bursa), bisa dilihat mundur per rentang jam beserta peringkat emiten teramai.
- **Detail per emiten** — klik kode emiten: delta kumulatif per menit (tekanan menguat
  atau melemah) dan footprint beli/jual agresif per level harga, lengkap sejak pembukaan.
  Jembatan dari "emiten mana yang rame" ke keputusan di satu emiten.
- **Indikator intraday (scalping)** — divergensi harga vs delta pada jendela 15 menit,
  POC & value area 70% dari footprint, opening range 09:00–09:29 beserta status
  breakout-nya, pita VWAP ±1σ/±2σ dengan posisi harga dalam satuan σ, dan laju tape
  (transaksi/detik dibanding rata-rata hari ini). Semua dari feed LT, tanpa OB2. Yang
  bergantung pada perekaman sejak pembukaan diberi tanda kalau arsipnya tidak lengkap.
- **Papan** — kolom kanan: SATU tabel yang menggabungkan peringkat kandidat (hari
  penuh: nilai, chg%, HAKA%, delta, zVwap, laju tape, divergensi, POC/value area)
  dengan kolom tekanan jendela bergulir 1m/5m/15m (nilai jendela, H vs K, HAKA%,
  arah, bukti). Baris = union peringkat nilai harian dan nilai jendela; live tiap
  2 detik, sort per kolom, klik baris membuka panel detail. Saat kolom filter
  diciutkan, kolom tengah & kanan bagi rata (50/50) supaya seluruh kolom Papan
  muat; kalau layar lebih sempit, tabel scroll horizontal tanpa memotong angka.
  Di mode riwayat menampilkan tanggal yang dipilih dari arsip (kolom jendela
  kosong).
- **Logout** — memutus sesi di server (bukan cuma sembunyikan tampilan), kembali ke
  layar QR.

## 5. Arah berikutnya: sinyal scalping & rekomendasi AI

Keputusan arah (14 Agu 2026): tool ini naik kelas dari "melihat yang lagi rame" menjadi
penjawab "apa yang layak di-scalp hari ini". Tiga komponen berikut saling menopang.

### 5.1 Sinyal manual: HAKA rame di area penting

Yang dicari mata scalper: transaksi beli agresif (HAKA) yang ramai, **khususnya saat
harga berada di area penting**. Definisi awal "area penting" — akan dikalibrasi dari
pemakaian nyata: sekitar VWAP, mendekati high/low hari ini, penutupan kemarin, dan
angka bulat psikologis.

Sudah ada: indikator intraday di panel detail (pita VWAP ±1σ/±2σ, opening range +
status breakout, POC & value area 70%, divergensi harga–delta) dan **Papan** —
satu tabel peringkat lintas emiten di kolom kanan (kandidat hari penuh + tekanan
jendela), live tiap 2 detik.
Belum ada: penandaan eksplisit "sedang di area penting" per baris (mis. "di value
area", "breakout OR", "di +2σ") — angka-angkanya sudah tampil, simpulan visualnya
belum diwarnai/diberi label.

### 5.2 Perekaman OB2 untuk kandidat otomatis

OB2 (orderbook) tetap **tidak** direkam untuk semua emiten — langganannya per simbol,
tidak scalable ke ~686 emiten. Yang direkam adalah OB2 emiten **kandidat otomatis**:
emiten yang lolos kriteria rame/HAKA hari itu, jumlahnya dibatasi (top N) supaya
tetap ringan. Rekaman ini jadi bahan analisa AI (5.3) dan nantinya menambah sinyal
manual (spread, offer wall).

### 5.3 Tombol rekomendasi AI — Claude vs Kimi vs DeepSeek

Satu tombol di dashboard. Saat diklik, server menjalankan **prompt yang sama dengan
data yang sama** ke tiga model: Claude, Kimi, dan DeepSeek. Prompt-nya menganalisa
running trade hari ini sampai detik klik (plus OB2 kandidat dari 5.2) dan diminta
memilih emiten yang layak di-scalp hari itu beserta alasannya.

- Hasil ketiga model ditampilkan **berdampingan** — penilaian akhir tetap di pengguna;
  perbedaan pendapat antar-model justru informasi.
- Pemanggilan **campuran, lewat CLI yang sudah terpasang** (terverifikasi POC 14 Agu 2026):
  `claude -p` untuk Claude; `kimi -m moonshot-ai/kimi-k2.6 -p` untuk Kimi; dan
  `kimi -m deepseek/deepseek-v4-pro -p` untuk DeepSeek — model dipilih EKSPLISIT
  per argumen, tidak bergantung default config. Tidak ada API key tambahan yang
  perlu dipegang server. Gagal satu model tidak membatalkan dua lainnya — panelnya
  menampilkan statusnya apa adanya.
- Output model tidak selalu JSON bersih (Claude suka bungkus markdown fence, CLI kimi
  kasih awalan "• "), jadi runner WAJIB parse defensif: buang fence/awalan, ambil dari
  `{` pertama sampai `}` terakhir, lalu validasi skema. POC tiga model sepakat
  mengklasifikasikan 12/12 kandidat uji secara konsisten — payload ringkasan (5.4)
  terbukti membawa sinyal yang cukup.
- Hasil diarsip per hari, supaya bisa dievaluasi mundur ("kemarin AI bilang X,
  jadinya bagaimana") — tanpa ini tidak ada cara mengkalibrasi prompt-nya.

### 5.4 Batasan data untuk prompt

Arsip livetrade ~25 MB/hari (ratusan ribu transaksi) **tidak mungkin dikirim mentah**
ke satu model pun, apalagi tiga — context window tidak muat dan biayanya tidak masuk
akal. Jadi server meringkas dulu menjadi payload analisa: peringkat emiten (nilai,
HAKA/HAKI, burst), transaksi besar terpilih, delta kumulatif & footprint kandidat,
dan OB2 kandidat. Payload inilah — bukan file mentah — yang dikirim identik ke tiga
model. "Analisa semua isi file" pada requirement dibaca sebagai "semua sinyal penting
dari file"; ringkasannya selalu bisa diperiksa ulang karena arsip mentahnya tetap ada.

## 6. Yang sengaja belum dikerjakan

- Sesi persisten lintas restart — kodenya sudah ada tapi IPOT menolak token lama
  (`#removeAuthToken`), jadi tiap restart tetap scan ulang. Sudah terbukti memakan korban:
  13 Agu 2026, 1,5 jam data sesi 1 hilang karena tidak ada yang scan QR setelah restart.
  Peringatannya kini ada, tapi akar masalahnya belum hilang.
- Umur `appsession` yang masih sah untuk login belum diketahui — 28 menit terbukti bisa,
  ~16 jam tidak. Untuk sekarang ditangani dengan menyambung ulang sebelum minta QR
  (`STALE_LOGIN_MS` di `collector.ts`), bukan dengan memahami batas sebenarnya.
- Arti nilai di dalam slot `[13]`/`[14]` (kemungkinan nomor order) — butuh arsip sehari
  penuh, jalankan `scanner/tools/analyze-lt.ts`.
- **RVOL & baseline relatif** — volume sekarang dibanding normalnya jam segini, supaya
  scanner menunjukkan yang paling *tidak biasa*, bukan sekadar yang paling ramai. Ini
  butuh profil agregat harian (volume per emiten per 5 menit, ~1 MB/hari, retensi
  60–90 hari) yang belum dibuat. Begitu ada, retensi arsip mentah bisa turun dari
  30 hari ke ~7 hari karena tugasnya tinggal memulihkan konteks hari berjalan.
- OB2 untuk **seluruh** emiten tetap tidak dikerjakan — langganan per simbol, tidak
  scalable ke ~686. Untuk kandidat otomatis sudah masuk rencana di 5.2. Untuk sisi
  agresor sendiri OB2 tidak lagi dibutuhkan.

## 7. Referensi

- [`scanner/README.md`](../scanner/README.md) — cara jalan (dev & deploy permanen),
  protokol IPOT, format pipe LT, setup domain lokal + HTTPS.

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
2. **Rekomendasi AI** — satu tombol yang mengirim kandidat hari itu ke model dan
   meminta pilihan emiten layak scalp beserta entry/invalidasi/target. Sudah jalan
   (lihat 5.3); rencana awal mengadu tiga model berubah — alasannya di sana.

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
                                                       market.ts   papan pasar (kolom Watchlist)
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
- **Live trade** — mengalir ke tabel begitu login berhasil. Panel QR duduk di dalam
  kolom Live Trade dan digantikan tabel saat login; dashboard tidak pernah tergerbang,
  karena riwayat/Watchlist/AI semuanya jalan dari arsip tanpa sesi.
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
  Sekarang ada notifikasi desktop, peringatan journal berkala, dan penanda `⚠ N mnt`
  di header dashboard berisi hitungan menit yang tidak terekam.
- **Arsip harian & riwayat** — setiap transaksi disimpan mentah per hari (~77 MB pada
  hari yang mengalir penuh; hari lampau dipadatkan gzip ~5,4×), bisa dilihat mundur per
  rentang jam beserta peringkat emiten teramai.
- **Analisa AI + percakapan sehari** — tombol AI di kolom Watchlist mengirim kandidat yang sedang
  tampil ke DeepSeek, hasilnya dirender jadi pick dengan entry/invalidasi/target. **Satu
  hari = satu benang percakapan**: klik berikutnya menyambung, bukan memulai baru, jadi
  model menjelaskan pick yang dikeluarkan alih-alih menghilangkannya diam-diam. Ada
  kotak chat untuk bertanya lanjutan, dan tombol Riwayat AI untuk membuka hari lampau.
- **Detail per emiten** — klik kode emiten: delta kumulatif per menit (tekanan menguat
  atau melemah) dan footprint beli/jual agresif per level harga, lengkap sejak pembukaan.
  Jembatan dari "emiten mana yang rame" ke keputusan di satu emiten.
- **Indikator intraday (scalping)** — divergensi harga vs delta pada jendela 15 menit,
  POC & value area 70% dari footprint, opening range 09:00–09:29 beserta status
  breakout-nya, pita VWAP ±1σ/±2σ dengan posisi harga dalam satuan σ, dan laju tape
  (transaksi/detik dibanding rata-rata hari ini). Semua dari feed LT, tanpa OB2. Yang
  bergantung pada perekaman sejak pembukaan diberi tanda kalau arsipnya tidak lengkap.
- **Watchlist** — kolom kanan: SATU tabel yang menggabungkan peringkat kandidat (hari
  penuh: nilai, chg%, HAKA%, delta, zVwap, laju tape, divergensi, POC/value area)
  dengan kolom tekanan jendela bergulir 1m/5m/15m (nilai jendela, H vs K, HAKA%,
  arah, bukti). Baris = union peringkat nilai harian dan nilai jendela; live tiap
  2 detik, sort per kolom, klik baris membuka panel detail. Saat kolom filter
  diciutkan, kolom tengah & kanan bagi rata (50/50) supaya seluruh kolom Watchlist
  muat; kalau layar lebih sempit, tabel scroll horizontal tanpa memotong angka.
  Di mode riwayat menampilkan tanggal yang dipilih dari arsip (kolom jendela
  kosong).
- **Logout** — memutus sesi di server (bukan cuma sembunyikan tampilan); kolom Live
  Trade kembali menampilkan panel QR.

## 5. Sinyal scalping & rekomendasi AI

Keputusan arah (14 Agu 2026): tool ini naik kelas dari "melihat yang lagi rame" menjadi
penjawab "apa yang layak di-scalp hari ini". Tiga komponen berikut saling menopang.
Status per 18 Agu 2026: **5.3 dan 5.4 sudah jalan**, 5.1 sebagian, 5.2 belum.

### 5.1 Sinyal manual: HAKA rame di area penting

Yang dicari mata scalper: transaksi beli agresif (HAKA) yang ramai, **khususnya saat
harga berada di area penting**. Definisi awal "area penting" — akan dikalibrasi dari
pemakaian nyata: sekitar VWAP, mendekati high/low hari ini, penutupan kemarin, dan
angka bulat psikologis.

Sudah ada: indikator intraday di panel detail (pita VWAP ±1σ/±2σ, opening range +
status breakout, POC & value area 70%, divergensi harga–delta) dan **Watchlist** —
satu tabel peringkat lintas emiten di kolom kanan (kandidat hari penuh + tekanan
jendela), live tiap 2 detik.
Belum ada: penandaan eksplisit "sedang di area penting" per baris (mis. "di value
area", "breakout OR", "di +2σ") — angka-angkanya sudah tampil, simpulan visualnya
belum diwarnai/diberi label.

### 5.2 OB2 untuk kandidat — SUDAH JALAN (19 Agu 2026)

OB2 (orderbook) tidak dilanggan untuk semua ~686 emiten — per simbol, dan ongkosnya
14–22 KB/menit masing-masing. Yang dilanggan adalah **roster kandidat hari itu**: tiap
emiten yang pernah masuk tabel Watchlist, ditahan sampai `OB2_MAX = 120`, disimpan ke
`logs/ob2-roster.json` supaya restart `whale-app` tidak menghilangkan daftarnya.

Langganan **tidak** digerakkan klik. Sempat dipertimbangkan memasangnya saat emiten
dibuka, dan itu keliru: kejadian orderbook tidak menunggu kita melihat, dan fitur yang
gunanya memberi tahu hal yang belum diperhatikan tidak boleh bergantung pada perhatian.

OB2 mentah tidak diarsipkan (555 MB/hari untuk 120 emiten vs 77 MB/hari milik LT). Yang
disimpan hanya turunan fiturnya.

### 5.2b Arah produk: tampilkan yang TIDAK ada di aplikasi sekuritas

Ini koreksi arah yang datang dari pengguna pada 19 Agu 2026, dan mengikat semua fitur
orderbook sesudahnya.

Versi pertama tangga buku menampilkan bid/ask beserta ukurannya — dan keberatannya sah:
itu persis yang sudah ditampilkan aplikasi sekuritas, jadi membangunnya ulang tidak
menambah apa-apa. Yang layak dibangun adalah **informasi yang tidak mereka punya**.

Aplikasi sekuritas menampilkan tembok yang ada **sekarang**. Ia tidak menyimpan riwayat
tiap tingkat harga, dan tidak pernah mencocokkan perubahan buku dengan transaksi yang
benar-benar terjadi di harga itu. Dari dua hal itulah muncul pembedaan yang tidak bisa
mereka lakukan:

```
tembok hilang + ada transaksi sebesar itu   → JEBOL, level benar-benar patah
tembok hilang + nyaris tanpa transaksi      → DITARIK, temboknya cuma pajangan
```

Pembedaan itu menuntut kedisiplinan sampai ke tingkat kata. Versi pertama menyebut
seluruh penyusutan tingkat sebagai "dimakan", padahal order yang dibatalkan ikut
terhitung — dan pada MEDC 1.425 (19 Agu 2026) 64% dari yang dilaporkan "diserap 23.661
lot" ternyata cuma order yang ditarik. Sekarang penyusutan dipisah menjadi `dimakan`
(cocok dengan transaksi LT) dan `ditarik`, dan absorpsi menuntut porsi dimakan ≥60%.

Keduanya terlihat identik di layar broker — angka yang tadi ada lalu tidak ada — padahal
artinya berlawanan. Narasi kejadian (`src/events.ts`) melaporkan empat jenis: `DITARIK`,
`JEBOL`, `ABSORPSI` (dimakan melebihi ukuran terbesarnya tapi masih berdiri), dan tembok
baru. Ambangnya relatif terhadap buku emiten itu sendiri, bukan angka mutlak.

Ujian untuk fitur orderbook berikutnya jadi satu kalimat: **apakah pengguna bisa
mendapatkan ini dengan menatap aplikasi sekuritasnya?** Kalau bisa, jangan dibangun.

### 5.3 Tombol rekomendasi AI — SUDAH JALAN (18 Agu 2026)

Terpasang, tapi **berbeda dari rencana di atas**. Yang dibangun: satu model
(**DeepSeek `deepseek-v4-pro`**, lewat API dengan kunci di `scanner/.env`), bukan tiga
model berdampingan lewat CLI.

Kenapa berubah: pengguna menyediakan kunci API DeepSeek, dan memanggil satu API
langsung jauh lebih sederhana daripada mengorkestrasi tiga proses CLI dengan parse
defensif atas tiga bentuk output yang berbeda-beda. Perbandingan antar-model tidak
hilang — tombol **Salin prompt** memberi transkrip lengkap yang bisa ditempel ke chat
model mana pun untuk dibandingkan manual. Kalau nanti perbandingan otomatis benar-benar
dibutuhkan, `src/ai.ts` sudah terpisah rapi dan tinggal ditambah pemanggil kedua.

Yang justru berkembang melampaui rencana: **percakapan berlanjut per hari**. Analisa
bukan hasil sekali jadi, melainkan pesan pertama sebuah benang. Sebabnya nyata: kalau
tiap klik memulai percakapan baru, pick yang hilang siang hari lenyap tanpa penjelasan
dan pembacanya bertanya-tanya. Sekarang analisa lanjutan memakai template khusus
(`prompts/scalp-lanjut.md`) yang mewajibkan menjelaskan apa yang dikeluarkan dan kenapa.
Terverifikasi ke model sungguhan — ia membandingkan angka lama dengan angka baru
("deltaM turun dari +7,5 menjadi +3,2"), bukan sekadar mengingat kesimpulan.

Hasil diarsip per hari (`logs/ai/`), lengkap dengan payload tiap analisa, supaya bisa
dievaluasi mundur — tanpa itu tidak ada cara mengkalibrasi prompt-nya.

Detail lengkap (skema balasan, normalisasi, cache prompt, batas waktu, biaya) ada di
[`scanner/README.md`](../scanner/README.md).

### 5.4 Batasan data untuk prompt

Arsip livetrade ~77 MB/hari (ratusan ribu transaksi) **tidak mungkin dikirim mentah** —
context window tidak muat dan biayanya tidak masuk akal. Jadi server meringkas dulu
menjadi payload analisa (`src/prompt.ts`): kandidat beserta nilai, HAKA%, delta
kumulatif, VWAP/zσ, opening range, POC/value area, divergensi 15m, laju tape, dan
footprint 3 level teramai. "Analisa semua isi file" pada requirement dibaca sebagai
"semua sinyal penting dari file"; ringkasannya selalu bisa diperiksa ulang karena arsip
mentahnya tetap ada.

Kandidatnya diambil dari `candidatesFor()` yang sama dengan tabel Watchlist dan diikat
konstanta `BOARD_N` yang sama — **yang dianalisa model dijamin persis yang dilihat
manusia di layar**. Payload analisa sebelumnya ikut dikirim sebagai konteks pada analisa
lanjutan, jadi model membandingkan angka, bukan cuma kesimpulan; prefiksnya identik tiap
panggilan sehingga cache prompt DeepSeek menanggung ~49% token input.

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
  scalable ke ~686. Untuk kandidat sudah jalan (5.2). Untuk sisi agresor OB2 tidak
  dibutuhkan sama sekali.
- **Kalibrasi ambang narasi kejadian** atas satu hari penuh. Sesi 19 Agu 2026 (2 menit)
  menghasilkan 50 kejadian, 27 di antaranya `DITARIK` dan terkonsentrasi di beberapa
  emiten ramai. Belum tentu berlebihan, tapi belum teruji sehari penuh.
- **Skor kejujuran buku per emiten** — berapa persen tembok besarnya lenyap tanpa
  bertransaksi, sebagai kolom di tabel Watchlist. Datanya sudah dihasilkan `events.ts`.
- Turunan LT x OB2 x VWAP yang belum dibangun: agregat spoof per emiten dan posisi
  tembok relatif terhadap VWAP. Spread sudah ada.

## 7. Referensi

- [`scanner/README.md`](../scanner/README.md) — cara jalan (dev & deploy permanen),
  protokol IPOT, format pipe LT, setup domain lokal + HTTPS.

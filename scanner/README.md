# Whale Scanner

Login QR ke IPOT + running trade live di halaman lokal.

## Dua proses: collector dan app

Sejak Agu 2026 scanner berjalan sebagai **dua** proses, dan pembagiannya bukan kosmetik:

| | Isi | Boleh direstart? |
|---|---|---|
| **collector** (`src/collector.ts`) | koneksi & sesi IPOT, tulis arsip | **Hindari saat bursa buka** |
| **app** (`src/app.ts`) | UI, filter, burst, tekanan, panel detail, riwayat | Bebas, sesering apa pun |

Alasannya: IPOT menolak token sesi yang dipulihkan (`#removeAuthToken`), jadi **setiap
restart proses yang memegang koneksi menuntut scan QR ulang**. Selama UI dan koneksi hidup
di proses yang sama, tiap perubahan UI memakan sesi — pada 13 Agu 2026 itu memakan ~3,5 jam
data dalam tiga kejadian terpisah. Sekarang restart app tidak menyentuh sesi sama sekali,
dan collector tetap menulis arsip walau app mati.

Keduanya bicara lewat Unix socket (`$XDG_RUNTIME_DIR/whale-scanner.sock`, mode 0600,
override dengan `WHALE_SOCKET`). Bingkainya JSONL; transaksi dikirim sebagai payload pipe
**mentah** — lossless dan ~72 byte alih-alih ~400 kalau dikirim sebagai objek.

```
IPOT WebSocket ──> collector ──> logs/lt/YYYY-MM-DD.txt   (arsip, tahan restart app)
                       │
                       └─(unix socket)──> app ──> browser
                                           │
                                           └── baca arsip untuk riwayat & panel detail
```

## Jalankan manual (dev)

```bash
cd scanner
npm install          # sekali saja
npm run collector    # terminal 1 — jarang perlu dimatikan
npm run app          # terminal 2 — bebas restart
```

1. Buka <http://127.0.0.1:3000> (atau <https://whale.scanner.local> kalau TLS diset).
2. Klik **Tampilkan QR**. Di HP: **IPOT → Member Area → Security → Login to IPOT Web** →
   scan QR (berlaku 60 detik). QR juga dicetak di terminal collector sebagai cadangan
   kalau belum ada app yang tersambung.
3. Login berhasil → halaman otomatis pindah ke dashboard, running trade mengalir.
4. Tombol **Logout** memutus sesi di collector, bukan cuma menyembunyikan tampilan.

`npm run dev:app` menjalankan app dengan reload otomatis — aman, karena collector tidak
ikut terpengaruh. Tombol terminal collector: `r` QR baru · `s` subscribe manual · `q` keluar.

Urutan start tidak penting: app menyambung ulang sendiri sampai collector ada.

## Jalan otomatis + domain lokal (`https://whale.scanner.local`)

Jalan sebagai **dua** systemd `--user` service di `~/.config/systemd/user/`:
`whale-collector.service` dan `whale-app.service` (yang lama, `whale-scanner.service`,
sudah di-disable). Auto-start setiap login/restart, auto-restart kalau crash. Diakses lewat
domain lokal dengan HTTPS asli (bukan "Not Secure") pakai sertifikat
[mkcert](https://github.com/FiloSottile/mkcert).

Yang perlu diingat sehari-hari:

```bash
systemctl --user restart whale-app.service        # aman kapan saja
systemctl --user restart whale-collector.service  # memutus sesi → wajib scan QR lagi
```

**Setup sekali saja** (sudah dikerjakan di komputer ini, dicatat untuk referensi/reinstall):

```bash
# 1. Root CA mkcert dipercaya browser (NSS store, tidak perlu sudo)
TRUST_STORES=nss mkcert -install

# 2. Sertifikat untuk domain lokal
cd scanner && mkdir -p certs
mkcert -cert-file certs/whale.scanner.local.pem \
       -key-file  certs/whale.scanner.local-key.pem \
       whale.scanner.local

# 3. Izin bind port 443 untuk binary node yang dipakai (BUTUH sudo, satu kali;
#    ulangi kalau versi node berubah lewat nvm)
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")"

# 4. Domain lokal menunjuk ke komputer sendiri (BUTUH sudo, satu kali)
echo "127.0.0.1 whale.scanner.local" | sudo tee -a /etc/hosts

# 5. Service systemd (dua-duanya)
systemctl --user daemon-reload
systemctl --user enable --now whale-collector.service whale-app.service
```

Setelah itu: buka <https://whale.scanner.local> — kalau Chrome/Firefox baru saja di-install
ulang CA-nya, restart browser dulu supaya sertifikatnya dipercaya.

Cek status / log:
```bash
systemctl --user status whale-collector.service whale-app.service
journalctl --user -u whale-collector.service -f   # login, sesi, arsip
journalctl --user -u whale-app.service -f         # UI, filter
```

Sertifikat `certs/*.pem` berlaku ~2 tahun (lihat tanggal exact: `openssl x509 -in certs/whale.scanner.local.pem -noout -enddate`),
tidak di-commit ke git (private key). Kalau expired, ulangi langkah 2 lalu `systemctl --user restart whale-app.service` (app yang memegang TLS, jadi collector tidak perlu disentuh).

## Struktur

```
src/collector.ts  ENTRY collector — sesi IPOT, reconnect, arsip, peringatan login
src/app.ts        ENTRY app — UI, filter, analitik, /api/*
src/bus.ts        saluran unix socket antara keduanya
src/ipot.ts     koneksi WebSocket IPOT, login QR, subscribe, parse pipe
src/filters.ts  filter transaksi, deteksi burst, tekanan HAKA/HAKI
src/archive.ts  arsip transaksi harian (logs/lt/), rotasi + retensi
src/history.ts  query rentang waktu dari arsip + ringkasan per emiten
src/symbol.ts   order flow per emiten: delta kumulatif + footprint per harga
src/market.ts   papan pasar semua emiten + kandidat (Papan & payload AI)
src/prompt.ts   bentuk payload AI + penggabungan template (dipakai tombol AI & CLI)
src/ai.ts       pemanggil DeepSeek + normalisasi balasan model
src/aihist.ts   riwayat AI: satu benang per hari (logs/ai/), migrasi bentuk lama
src/notify.ts   notifikasi desktop (notify-send), fire-and-forget
src/server.ts   http lokal + push WebSocket ke browser + /api/*
public/index.html  halaman login (QR) + dashboard 3 kolom + mode riwayat
tools/analyze-lt.ts   bedah field feed dari arsip satu hari
tools/backfill-lt.ts  pemulihan: tarik payload LT lama dari frames.jsonl
tools/build-payload.ts  payload/prompt analisa AI dari baris perintah, atas arsip
prompts/scalp.md        template analisa pertama hari itu + skema JSON balasan
prompts/scalp-lanjut.md template analisa LANJUTAN — wajib jelaskan pick yang hilang
tools/replay.ts         uji UI: putar ulang arsip lewat bus, tanpa menyentuh IPOT
logs/lt/YYYY-MM-DD.txt  arsip transaksi, satu payload mentah per baris
logs/frames.jsonl       frame protokol NON-LT, dibatasi ~20MB (auto-rotasi)
```

## Arsip harian & riwayat

Setiap transaksi ditulis apa adanya ke `logs/lt/YYYY-MM-DD.txt` — satu payload pipe
per baris, sebelum disaring filter apa pun. **73 byte per transaksi**, dan pada hari
bursa yang mengalir penuh laju terukurnya **0,23 MB/menit (3.224 transaksi/menit)** —
sekitar **77 MB per hari**. Retensi default 30 hari (`ARCHIVE_DAYS`).

> Angka lama di dokumen ini pernah menyebut ~25 MB/hari. Itu meleset tiga kali lipat:
> perkiraannya bersandar pada arsip 12 Agu 2026 yang belakangan terbukti berlubang besar
> dan hanya mencakup sore yang lebih sepi. 14 Agu 2026 adalah pengukuran pertama dari
> perekaman yang benar-benar mengalir.

**Hari yang sudah lewat dipadatkan** jadi `logs/lt/YYYY-MM-DD.txt.gz`. Payload pipe
sangat berulang, jadi gzip memangkasnya **~5,4×** (terukur: 5,2 MB → 0,9 MB). Hari
berjalan tidak pernah dipadatkan karena file-nya masih di-append. Pemadatan jalan saat
collector start dan saat pergantian hari; `readDay`, `sizeOf`, dan `startTime` mengenali
kedua bentuk, jadi riwayat dan panel detail bekerja sama saja atas arsip padat.

Karena membaca arsip padat menuntut membuka seluruh file, jam transaksi pertama per
tanggal di-cache — panel detail memintanya tiap kali dibuka, sementara hari lampau tidak
berubah lagi.

Dengan disk yang sudah 91% penuh, retensi 30 hari berarti ~2,3 GB mentah atau ~0,43 GB
padat. Untuk fokus scalping intraday, 7 hari sebenarnya cukup — tugas arsip tinggal
memulihkan konteks hari berjalan dan menjadi bahan riset protokol.

Frame LT sengaja **tidak lagi** masuk `frames.jsonl`: jumlahnya menenggelamkan frame
protokol lain sampai file itu memotong diri sendiri di 20 MB. Sekarang frames.jsonl
hanya memuat frame non-LT (plus frame LT yang gagal di-parse — justru itu yang menarik),
jadi ia berguna kembali untuk membedah protokol.

Tombol **Riwayat** di dashboard membaca arsip lewat `/api/history`: pilih tanggal dan
rentang jam, tabel menampilkan transaksi yang cocok, dan kolom kanan berubah menjadi
peringkat emiten teramai di rentang itu. Saringan di kolom kiri ikut berlaku.

```
GET /api/days      → tanggal yang tersedia + ukurannya
GET /api/history?date=2026-08-12&from=1545&to=1550&minValue=500000000&limit=2000
                   → { scanned, matched, trades[], symbols[] }
```

Ringkasan per emiten dihitung dari **seluruh** transaksi di rentang itu, bukan hanya
yang lolos saringan — alasannya sama dengan burst: kalau ringkasan ikut disaring ambang
nilai besar, "emiten yang rame" justru tidak terlihat rame.

## Catatan protokol

Semua lewat satu WebSocket `wss://ipotapp.ipot.id/socketcluster/?appsession=<token>`.

| Langkah | Pesan |
|---|---|
| Handshake | `{"event":"#handshake","data":{"authToken":null},"cid":N}` |
| Ping | server kirim `#1`, balas `#2` |
| Minta QR | `{"event":"login","data":{"cmdid":N,"param":{"cmd":"getqr","lazy":true}}}` |
| Balasan QR | `event:"record"` → `result.info.qrcode` (hex 64), `span:60` |
| Subscribe LT | `{"event":"cmd","data":{"cmdid":N,"param":{"cmd":"subscribe","service":"mi","rtype":"LT","subscribe":true}}}` |

**Penting:** subscribe `LT` **tanpa** `code` dan **tanpa** `subsid`. Menambahkan keduanya
membuat server membalas `NOSERVICE` — ini yang membuat versi Rust tidak pernah menerima data.

## Format pipe LT (terverifikasi 11 Agu 2026, 30.941 transaksi)

```
B |133123| 0 |ULTJ| RG |01262562|1505| 4 |--|-|--|-|1495|00|3460056|10|0|1499|0|1
0    1     2    3    4      5      6   7  8  9 10 11  12  13   14   15 16  17 18 19
```

| Idx | Isi | Catatan |
|---|---|---|
| 1 | jam `HHMMSS` | |
| 3 | kode emiten | 686 emiten unik terpantau |
| 4 | papan | `RG` reguler, `NG` negosiasi, `TN` tunai |
| 5 | nomor urut transaksi | global, naik terus |
| 6 / 7 | harga / lot | |
| 12 | harga penutupan sebelumnya | |
| 13 / 14 | **sisi agresor** | lihat di bawah — yang bermakna posisinya, bukan nilainya |
| 15 | perubahan harga | = `[6]-[12]`, cocok 30941/30941 |
| 16 | tick | selisih harga vs transaksi sebelumnya di emiten yang sama |
| 17 | **VWAP** | harga rata-rata tertimbang volume, per emiten **+ papan** |
| 18 | % perubahan | dibulatkan ke bawah, cocok 30941/30941 |

`[0]`=B, `[2]`=0, `[19]`=1 selalu konstan. `[8]`–`[11]` selalu kosong.

### `[13]`/`[14]` — sisi agresor (terverifikasi 13 Agu 2026)

Feed selalu mengisi paling banyak **satu** dari dua slot itu dengan angka ~7 digit; slot
lainnya `00`. Yang menentukan arah adalah **slot mana yang dipakai**:

| Slot terisi | Artinya |
|---|---|
| `[14]` | transaksi di harga **offer** → pembeli mengambil (**HAKA**) |
| `[13]` | transaksi di harga **bid** → penjual mengambil (**HAKI**) |
| dua-duanya `00` | tidak disebutkan — lihat catatan lelang di bawah |

Bukti, dari 45.110 transaksi:

- Dalam satu emiten, harga di baris ber-slot `[14]` konsisten **lebih tinggi** daripada
  baris ber-slot `[13]` — pola bid vs offer. Diuji per transaksi terhadap harga slot
  seberangnya yang terakhir: **23.113 konsisten vs 66 melanggar (99,7%)**.
- Diperiksa silang dengan tick rule pada transaksi yang bisa dinilai keduanya:
  **98,6% sepakat** (`[14]`↔uptick, `[13]`↔downtick).

**Cakupan bergantung fase perdagangan, bukan merata.** Selama sesi berjalan, papan RG:

| | punya sisi agresor | punya `tick != 0` (cara lama) |
|---|---|---|
| transaksi | **100,0%** | 18,6% |
| nilai | **100,0%** | 16,8% |

Slot berhenti diisi **tepat pukul 16:00:00** — batas sesi 2. Transaksi setelah itu adalah
**lelang penutupan**, dan di sana slot selalu kosong. Itu bukan kekurangan feed tapi
memang benar: lelang menyilangkan order pada satu harga, tidak ada pihak yang berperan
sebagai agresor. Buktinya tick rule juga kosong di fase yang sama (1 dari 16.075
transaksi). Jadi kalau sebuah pengukuran atas seluruh arsip harian melaporkan cakupan
di bawah 100%, periksa dulu komposisi jamnya sebelum menyimpulkan ada lubang data.

Anomali kecil: 18 dari ~90.000 slot berisi `10` alih-alih angka 7 digit. Parser
menganggapnya terisi seperti biasa; dampaknya 0,04% dan belum diselidiki.

Nilai di dalam slotnya sendiri **belum jelas**: bukan volume, bukan nilai, bukan
frekuensi (kumulatif per emiten maupun pasar — semuanya 0% cocok). Kemungkinan nomor
order: naik terus, dan sering berulang sama persis saat satu order agresor memakan
beberapa order lawan. Jalankan `npx tsx tools/analyze-lt.ts <tanggal>` atas arsip sehari
penuh untuk melanjutkan.

Ini mengoreksi catatan lama di repo ini yang menyatakan feed LT tidak memuat sisi
agresor dan bahwa HAKA/HAKI hanya mungkin lewat orderbook (`OB2`). Untuk **spread** dan
**offer wall**, `OB2` tetap dibutuhkan.

### `[17]` — VWAP (terverifikasi 13 Agu 2026)

Harga rata-rata tertimbang volume, kumulatif sejak pembukaan, dibulatkan ke rupiah.
Diuji dengan mencari satu parameter bebas (volume sebelum arsip mulai) yang harus
menjelaskan seluruh lintasan `[17]`: pada CUAN galatnya **median di bawah Rp 1 sepanjang
3.402 titik**. Rumus itu bisa dibalik untuk **merekonstruksi volume kumulatif emiten
sejak pembukaan** walau scanner baru login tengah hari.

**Dihitung per emiten + papan, bukan per emiten.** GOTO pernah tercatat VWAP 33 di papan
NG sementara di RG 50. Karena NG/TN hanya berisi segelintir transaksi, VWAP di papan itu
sering sama dengan harga transaksinya sendiri — jadi kolom "vs VWAP" hanya bermakna untuk
RG, dan di papan lain ditampilkan redup.

## Filter yang tersedia

Emiten (watchlist + preset LQ45) · nilai minimum · lot minimum · papan RG/NG/TN ·
rentang harga · rentang % perubahan · **rentang % terhadap VWAP** · jam ·
burst (N transaksi dalam T detik).

Burst dihitung dari **semua** transaksi emiten, bukan hanya yang lolos filter — kalau
tidak, ambang nilai besar membuat burst mustahil terpicu.

## Tekanan HAKA/HAKI

Dihitung dari **sisi agresor yang disebutkan feed** (slot `[13]`/`[14]`, lihat di atas),
bukan lagi ditebak dari tick rule. Transaksi yang sisinya tidak disebutkan feed tetap
tidak ditebak arahnya — ia hanya dihitung sebagai ukuran keramaian. Emiten dengan bukti
< 10 transaksi disembunyikan dari peringkat.

Ditimbang **nilai**, bukan jumlah transaksi. Sama untuk panel live maupun ringkasan
riwayat.

**Riwayat perubahan.** Panel ini dulu memakai tick rule pada field `[16]`, yang selama sesi
berjalan hanya bisa menilai 18,6% transaksi RG (16,8% nilai). Sisi agresor dari feed
mencakup **100%** dan sepakat 98,6% dengan tick rule di tempat keduanya bisa dinilai — jadi
ini bukan tukar asumsi, tapi data yang sama tanpa lubang. Tick rule tidak lagi dipakai di
panel ini: setiap transaksi ber-tick juga punya sisi agresor, jadi ia tidak menambah apa
pun. Kolom **Tick** di tabel tetap ada sebagai fakta mentah dari feed.

Akibatnya emiten yang dulu tersembunyi karena bukti < 10 kini muncul, dan `hakaPct` tidak
lagi bersandar pada seperlima data. Angkanya **akan berbeda** dari sebelumnya — itu
disengaja.

Yang masih berlaku dari keputusan lama: arah transaksi yang tidak diketahui **tidak
ditebak**. Dulu pewarisan arah dari transaksi sebelumnya terbukti membalik kesimpulan
pada 28% emiten, dan prinsip itu tidak berubah — hanya sumber datanya yang jadi lebih baik.

## Papan (kandidat + tekanan, satu tabel)

Kolom kanan menampilkan SATU tabel peringkat yang menggabungkan dua sisi:

- **Kandidat (hari penuh)** — indikator yang **sama persis dengan payload analisa
  AI** (yang dibaca manusia di UI dan yang dianalisa model tidak boleh berbeda;
  keduanya dari `src/market.ts`): harga, chg%, delta kumulatif, HAKA%, posisi vs
  VWAP (zσ), laju tape, divergensi 15m, nilai — plus POC/value area dan footprint
  3 level teramai di tooltip baris.
- **Tekanan (jendela 1m/5m/15m)** — nilai jendela, bar H vs K, HAKA% jendela, arah
  (BELI/JUAL/imbang), bukti. Ambang verdict sama dengan panel tekanan lama.

Kolom **ARAH** punya lima tingkat, tapi hanya dua kata:

| HAKA% jendela | Tampilan |
|---|---|
| ≥ 60 | `BELI` hijau penuh |
| 52–59 | `BELI` hijau diredupkan |
| 49–51 | `imbang` abu-abu |
| 41–48 | `JUAL` merah diredupkan |
| ≤ 40 | `JUAL` merah penuh |

Keyakinan tipis ditandai **redup**, bukan huruf kecil. Versi sebelumnya memakai
`beli`/`jual` huruf kecil untuk tingkat tipis; itu terbaca sebagai inkonsistensi
penulisan, bukan sebagai tingkatan — pengguna menanyakannya sebagai kesalahan, yang
sekaligus jadi buktinya bahwa penyandiannya gagal. Ambangnya dinilai dari angka yang
**sudah dibulatkan** seperti yang tampil di kolom sebelahnya, supaya tidak ada baris
bertuliskan "40" tapi berverdict tipis (40,4 dibulatkan turun).

Baris = **union** peringkat nilai harian dan nilai jendela: emiten yang ramai pagi
tapi sepi sekarang tetap tampil, dan yang baru memanas sekarang ikut muncul walau
nilai hariannya kecil. Klik judul kolom untuk mengurutkan; klik kode emiten membuka
panel detail. Saat kolom filter diciutkan (burger), kolom tengah & kanan **bagi rata
50/50** sehingga seluruh kolom Papan muat; kalau layar lebih sempit, tabel scroll
horizontal tanpa memotong angka.

- **Live**: diperbarui tiap 2 detik — harian dari papan pasar di memori
  (`MarketBoard`), jendela dari `Scanner.pressureAll()`.
- **Mode riwayat**: memuat tanggal yang dipilih dari arsip (butuh beberapa detik;
  tombol ↻ memuat ulang). Kolom jendela kosong — tekanan jendela hanya konsep live.

```
GET /api/candidates?n=15[&date=YYYY-MM-DD]
                   → { date, live, recordedFrom, rows[] } — tiap baris memuat field
                     `win` (nilai/hakaPct/bukti jendela) untuk hari berjalan, null
                     untuk tanggal lampau
```

### Tombol AI

Di ujung kanan baris meta (tepat di bawah tombol 15m). Sekali klik: kandidat yang
**sedang tampil di tabel ini** dikirim ke model bersama template `prompts/scalp.md`,
dan jawabannya dirender jadi modal — ringkasan pasar, maksimal 5 pick dengan
entry/invalidasi/target (plus selisih %-nya terhadap entry), keyakinan 1–5, alasan,
angka bukti, dan daftar `dihindari`. Kode emiten di hasil bisa diklik langsung ke panel
detail.

Kandidatnya lewat `candidatesFor()` yang sama dengan tabel, dan jumlahnya diikat
konstanta `BOARD_N` yang sama dengan push live — supaya prompt tidak pernah berisi
emiten yang tidak ada di layar. Bentuk payload ada di `src/prompt.ts`, dipakai bersama
`tools/build-payload.ts` sehingga tombol dan CLI tidak bisa menghasilkan bentuk berbeda.

**Provider: DeepSeek** (`src/ai.ts`, endpoint OpenAI-compatible). Model bawaan
`deepseek-v4-pro`; `deepseek-v4-flash` lebih murah dan cepat. Balasan diminta JSON mode,
lalu tetap **dinormalisasi** di server: model bisa mengirim JSON sah tapi berbentuk lain,
dan halaman tidak boleh menerima bentuk yang tidak dikenal. Field asing dibuang, yang
hilang diberi nilai kosong.

Kunci dibaca dari `scanner/.env` (mode 0600, **di-gitignore — repo ini publik**), dimuat
`app.ts` lewat `process.loadEnvFile()` supaya `npm run app` manual juga dapat kunci yang
sama. Contoh isian ada di `.env.example`. Tanpa kunci, endpointnya membalas error dan
prompt tetap bisa disalin manual.

Modal selalu menyediakan tombol **Salin prompt** — berguna untuk membandingkan jawaban
model lain atas data yang sama, dan jadi jalan keluar kalau panggilan gagal (saldo habis,
model sibuk): server tetap mengirim `prompt` di balasan error, jadi tidak pernah buntu
total.

Yang disalin **berdiri sendiri**, bukan cuma giliran terakhir. Lewat API konteks dikirim
sebagai `messages[]` terpisah, tapi chat AI lain cuma menerima satu kotak teks —
sementara template lanjutan berbunyi *"Di atas ada analisa dan pembicaraan kita
sebelumnya hari ini"*. Tanpa perataan, kalimat itu bohong: modelnya diberi tahu ada
konteks yang tidak pernah ikut, lalu diminta menjelaskan pick yang hilang tanpa tahu
pick sebelumnya apa. `flattenTranscript()` meratakan percakapan sehari jadi satu teks
bertanda peran (`----- [n] SAYA / KAMU -----`), diikuti `===== GILIRAN SEKARANG =====`.
Terukur: 8.445 → 34.243 karakter untuk hari dengan 2 analisa + 3 tanya.

**Menunggu 2–3 menit itu normal**, dan itu menuntut UI-nya jujur. Terukur: 103–167 detik
untuk 19–20 kandidat di `deepseek-v4-pro`. Batasnya 300 detik. Maka:

- Tombolnya menghitung detik (`AI 45s`) — **di tombol**, bukan hanya di dalam modal,
  supaya progresnya terlihat walau panelnya ditutup.
- Modal **terbuka sendiri** begitu jawabannya datang. Tanpa ini, hasil yang sudah dibayar
  mendarat di panel tersembunyi dan hilang tanpa jejak — persis yang terjadi 18 Agu 2026:
  server mencatat `AI: 2 pick · 134 dtk` sementara di layar tidak ada apa-apa.
- Tombolnya **tidak** di-disable saat menunggu: tombol nonaktif tidak mengirim event klik,
  jadi tidak bisa dipakai membuka lagi panel yang tertutup. Permintaan ganda dicegah
  flag `aiBusy`, bukan atribut `disabled`.
- Hasil terakhir disimpan. Klik lagi setelah panel ditutup → hasil lama ditampilkan,
  **tanpa** memanggil (dan membayar) model lagi.

`deepseek-v4-flash` cuma ~30% lebih cepat (90 dtk terukur) dan lebih ceroboh — ia sempat
mengeluarkan harga pecahan seperti 149,9 yang tidak mungkin ada di papan IDX. Karena itu
`src/ai.ts` membulatkan entry/invalidasi/target ke rupiah apa pun modelnya.

Cek sisa saldo:
`curl -s https://api.deepseek.com/user/balance -H "Authorization: Bearer $KEY"`.
Biaya sekali panggil di bawah $0,005 — saldo $2,51 tidak bergerak setelah beberapa kali.

```
GET /api/prompt[?date=YYYY-MM-DD][&n=15]  → { date, count, lanjutan, prompt } | { error }
                                            `prompt` = transkrip sehari + giliran baru
GET /api/ai    [?date=YYYY-MM-DD][&n=15]  → { id, date, count, result, usage, prompt, tookMs }
                                          | { error, prompt }
```

### Riwayat: satu hari = satu benang percakapan

Tombol **Riwayat AI** di kanan tombol AI. Modal penuh layar: daftar **hari** di kiri
("Hari ini · 2 analisa · 3 tanya"), percakapan sehari penuh di kanan.

**Tiap klik tombol AI menyambung benang hari itu, bukan memulai yang baru.** Ini
keputusan penting, bukan kerapian. Kalau tiap klik memulai percakapan baru, model tidak
tahu ia pernah merekomendasikan DSSA pagi tadi — jadi saat DSSA hilang dari analisa
siang, ia diam saja dan pembacanya bertanya-tanya. Padahal **hilangnya sebuah pick
sering lebih berguna daripada pick barunya**: target tercapai, invalidasi kena, atau
tekanan belinya habis — semuanya informasi.

Analisa kedua dan seterusnya memakai template `prompts/scalp-lanjut.md` yang dipilih
otomatis, dan mewajibkan field `perubahan`: apa yang berubah, terutama pick yang
dikeluarkan **beserta alasannya**. Di layar blok itu diberi aksen kuning di atas
pick-nya. Selebihnya sama; pertanyaan lanjutan bisa langsung diajukan di benang itu.

Konteks yang dikirim = seluruh benang: payload asli tiap analisa (dibaca dari `p/`) +
jawabannya + tanya-jawab. Payload lama ikut supaya model membandingkan **angka** lama
dengan angka baru, bukan cuma kesimpulan. Prefiksnya identik di tiap panggilan, jadi
cache prompt DeepSeek menanggung sebagian besar biayanya.

Payload yang berkasnya sudah hilang diganti penanda, **bukan dilewatkan diam-diam**:
kalau jawaban asisten muncul tanpa pertanyaan yang mendahuluinya, urutan peran jadi
kacau dan model bisa salah membaca siapa mengatakan apa.

Dua berkas terpisah di `logs/ai/` (`src/aihist.ts`), sengaja:

| Berkas | Isi | Kenapa terpisah |
|---|---|---|
| `history.jsonl` | satu baris per **hari**: seluruh item, ±2–10 KB | dibaca **utuh** tiap buka daftar |
| `p/<tanggal>-<n>.txt` | payload tiap analisa, ±12 KB | hanya saat menyusun konteks atau diminta |

Kalau payload ikut di JSONL, membuka daftar berarti mem-parse belasan MB tanpa alasan.
Retensi 120 hari. Entri bentuk lama (satu entri per klik, `result` + `turns[]`) otomatis
dinaikkan ke bentuk benang saat dibaca — riwayat yang sudah ada tidak perlu dibuang.

Panel live dan panel riwayat dirender fungsi yang sama (`renderAiInto`), jadi percakapan
lama tidak pernah tampil beda dari yang baru keluar. Kode emiten di hasil bisa diklik:
panel riwayat menutup, panel detail order flow terbuka.

```
GET /api/ai/list           → { entries: [{ id, date, ts, updated, analyses, chats,
                                           symbols[], model }] }   (id = tanggal)
GET /api/ai/entry?id=<tgl> → { id, date, ts, updated, items[], lastPrompt } | { error }
                             items[] = { kind:'analysis'|'user'|'assistant', ts, … }
```

### Tanya-jawab lanjutan

Analisa awal bukan hasil sekali jadi — ia **pesan pertama sebuah percakapan**. Di bawah
hasilnya ada kotak chat (Enter kirim, Shift+Enter baris baru), tersedia di panel live
maupun panel riwayat. Pertanyaan lanjutan dijawab dengan membawa konteks penuh, jadi
"kenapa DSSA cuma 3 bintang?" atau "bandingkan BREN vs ISAT" bisa dijawab tanpa
mengulang datanya.

Konteks disusun ulang **di server dari yang tersimpan**, bukan dari apa pun yang dikirim
halaman: prompt asli → jawaban awal (JSON) → seluruh tanya-jawab sesudahnya → pertanyaan
baru. Dua akibatnya penting: model melihat percakapan yang sama persis dengan yang
terbaca di layar, dan halaman tidak bisa menyelundupkan konteks yang tidak pernah terjadi.

Balasan lanjutan **tidak** dipaksa JSON — memaksakannya hanya membuat model menjawab
pertanyaan terbuka dalam bentuk yang canggung. Teksnya ditampilkan apa adanya
(`white-space:pre-wrap`), kecuali `**tebal**` yang diterjemahkan karena model memakainya
di hampir tiap jawaban dan bintang mentahnya mengganggu dibaca. Escaping jalan **lebih
dulu**, baru tagnya ditambahkan — urutan itu yang membuatnya aman (diuji: `<img
onerror=…>` dari model tetap jadi teks mati). Sisa markdown sengaja tidak ditangani:
tidak cukup sering muncul untuk menebus permukaan yang bisa salah.

Pertanyaan Anda muncul sebagai gelembung menempel kanan, jawaban model menempel kiri —
pola aplikasi chat. Warnanya biru-aksen, **bukan hijau seperti WhatsApp**: di aplikasi ini
hijau dan merah sudah berarti beli/jual, dan memakainya untuk gelembung chat menyesatkan.
Isi gelembung tetap rata kiri walau gelembungnya di kanan (persis WhatsApp) — teks rata
kanan membuat tepi kirinya bergerigi begitu lebih dari sebaris.

Giliran disimpan sebagai item di benang hari itu. Barisnya **ditulis ulang di
tempat**, bukan di-append sebagai baris baru: satu id harus tetap satu baris, kalau tidak
`get()` mengembalikan versi mana pun yang ketemu duluan dan percakapannya terpecah.

Percakapan hanya bisa dilanjutkan kalau prompt aslinya masih ada — tanpa itu model
kehilangan data yang melahirkan analisanya, jadi kotak chatnya disembunyikan.

```
POST /api/ai/chat  { id, message }  → { reply, usage, tookMs } | { error }
```

## Detail per emiten (order flow)

Klik kode emiten di tabel mana pun → panel detail. Ini jembatan dari "emiten mana yang
rame" ke "apa yang sebenarnya terjadi di emiten ini" — panel lain semuanya lintas-emiten.

Panelnya setinggi layar dan terbagi tiga kolom, dipisah menurut sifat isinya:

| Kolom | Isi |
|---|---|
| **kiri** | keadaan apa adanya — harga, perubahan, VWAP, vs VWAP, high/low, nilai, transaksi, laju tape, plus nilai lelang & blok NG/TN yang tidak masuk hitungan |
| **tengah** | grafik harga + delta kumulatif, dan divergensi (ia membaca grafik itu sendiri) |
| **kanan** | yang diturunkan — tekanan HAKA/HAKI, POC, value area, pita ±1σ, posisi terhadap VWAP, opening range, footprint |

Tiap kolom scroll sendiri supaya footprint yang panjang tidak mendorong grafik keluar
layar, dan tinggi grafik mengikuti tinggi viewport.

- **Delta kumulatif** per menit: nilai beli agresif dikurangi jual agresif, ditumpuk sejak
  pembukaan. Menjawab yang tidak bisa dijawab panel tekanan: apakah tekanan sedang
  *menguat atau melemah*, bukan cuma posisinya sekarang.
- **Footprint**: volume beli vs jual agresif **per level harga**. Memperlihatkan di harga
  mana agresi menumpuk — tidak terlihat dari total volume.
- VWAP, high/low, dan blok NG/TN dipisah dari hitungan (negosiasi tidak punya agresor).

### Cara membaca grafiknya

Dua baris sejajar berbagi sumbu waktu — **atas garis harga, bawah batang delta kumulatif**.
Yang dicari adalah saat keduanya **tidak sejalan**:

| Garis harga | Batang delta | Artinya |
|---|---|---|
| naik | ikut naik | kenaikan didukung pembeli agresif |
| naik | datar / turun | tenaga beli habis — kenaikan rapuh |
| turun | ikut turun | penurunan didorong penjual agresif |
| turun | datar / naik | penjual habis — penurunan rapuh |

Contoh nyata (IRSX, 14 Agu 2026): harga merangkak naik ke 374 sementara delta menanjak
tajam — sampai di situ sehat. Lalu delta **mendatar** dan harga langsung balik ke 368 dan
menggantung. Pembeli agresif berhenti, harga tidak punya penopang lagi.

Skala delta mengikuti data, bukan dipaksa simetris: kalau seluruh delta positif, garis nol
jatuh di dasar dan batang memakai seluruh tinggi. Versi sebelumnya selalu membagi 50/50
dan menumpuk garis harga di atas batang dengan skala berbeda — hasilnya garis harga jatuh
di paruh bawah yang kosong dan terbaca seolah bagian dari delta negatif.

Panel ini menutup hampir seluruh layar, dan menutupnya **tidak memuat ulang apa pun**:
tabel live tetap mengalir di belakang selama panel terbuka.

### Indikator intraday di panel ini

**Divergensi harga vs delta.** Harga naik sementara cumulative delta turun berarti
kenaikan itu tidak didukung pembeli agresif — pertanda tenaga habis, dan kebalikannya
untuk bullish. Dihitung pada jendela 15 menit bergulir dengan membandingkan awal dan
akhir jendela, **bukan** deteksi swing: swing menuntut parameter yang harus
dicocok-cocokkan dan hasilnya sulit dipertanggungjawabkan. Yang di sini bisa dibaca apa
adanya — *"15 menit terakhir harga +1,59% tapi delta −3,65 M"*.

Ada dua penjaga supaya tidak berisik: gerak harga minimal 0,15% dan ketidakseimbangan
minimal 5% dari nilai yang diperdagangkan di jendela itu. Tanpa keduanya hampir setiap
emiten akan selalu "divergen", karena harga dan delta jarang bergerak persis sejalan.

Grafik delta juga menampilkan **garis harga** di atas batangnya. Skalanya sengaja bebas
dan tanpa sumbu — yang dicari bentuknya, bukan nilainya: garis naik sementara batang
menyusut adalah divergensi yang langsung terlihat mata.

**POC & value area.** Point of control = harga dengan volume terbesar hari ini; value
area = rentang yang memuat ~70% volume, dibangun dari POC melebar ke sisi yang levelnya
lebih besar. Keduanya dari footprint (papan RG), jadi ini support/resistance berdasar
volume nyata, bukan garis tarikan. Ditandai di tabel footprint dan di header. `coverage`
ikut dilaporkan karena bisa meleset dari 0,7 saat level harganya sedikit — lebih baik
terlihat daripada dibulatkan diam-diam.

**Pita VWAP (±1σ, ±2σ).** Acuan target dan stop yang paling umum dipakai scalper. Pusatnya
VWAP dari feed — angka yang dilihat semua pelaku pasar — sementara simpangan bakunya
terpaksa dihitung sendiri dari transaksi yang terlihat, karena feed tidak mengirimkannya.
Dipakai Welford tertimbang volume, bukan Σ(q·p²): pada emiten harga tinggi yang ramai,
jumlah kuadrat itu bisa menyentuh batas presisi `Number` dan variansnya jadi kacau.

`z` menunjukkan posisi harga terhadap VWAP dalam satuan σ, dan hanya diberi warna kalau
sudah melewati 1σ supaya gerak kecil tidak terlihat berarti. Garis VWAP juga digambar
putus-putus di grafik harga, dan ikut masuk domain skala — tanpa itu, saat harga menjauh
VWAP-nya keluar kotak, padahal justru saat itulah ia paling penting.

Tooltipnya menyebut **VWAP feed vs VWAP hitungan sendiri**. Selisih keduanya adalah ukuran
langsung seberapa parsial data kita: kalau berdekatan, pitanya bisa dipercaya. Contoh nyata
14 Agu 2026 (perekaman mulai 09:44, bukan 09:00) — IRSX feed 365 vs hitungan sendiri 367,48.

**Laju tape.** Transaksi per detik dalam 60 detik terakhir, dibanding rata-rata emiten itu
sepanjang hari ini. **Bukan RVOL**: pembandingnya hari ini sendiri, bukan perilaku normal
lintas hari — untuk itu perlu profil agregat harian yang belum dibuat. Tetap berguna karena
lonjakan laju sering mendahului pergerakan harga; ADRO sempat tercatat 3,89× rata-ratanya
sendiri saat harga menembus ke atas VWAP.

Baseline-nya memakai jumlah menit yang punya transaksi, bukan rentang jam — emiten yang
sepi berjam-jam tidak seharusnya terlihat "meledak" hanya karena pembaginya besar.

**Opening range.** High/low 09:00–09:29, dengan status apakah harga terakhir menembus ke
atas, ke bawah, atau masih di dalam. **Hanya sah kalau perekaman mulai dari pembukaan** —
kalau `recordedFrom` lewat dari 09:01, angkanya tetap ditampilkan tapi diredupkan dan
diberi tanda `(?)`, karena sebagian rentangnya tidak pernah terlihat.

Beberapa hal yang sengaja dibuat eksplisit di panel ini:

- Nilai **tanpa sisi agresor** dan **blok NG/TN** disebutkan terang-terangan di header,
  supaya tidak terlihat seolah seluruh nilai emiten sudah terwakili hitungan tekanan.
- Level footprint yang isinya hanya lelang penutupan diberi label `lelang N lot`, bukan
  dibiarkan tampak sebagai baris kosong — justru di level itu harga penutupan terbentuk.
- Judul menyebut tanggal kalau yang dilihat bukan hari berjalan.

Cara kerjanya: saat panel dibuka, server mengisi dari arsip hari itu (`backfill`) supaya
lengkap **sejak pembukaan**, lalu memperbaruinya dari feed live. Tanpa backfill, panel
baru terisi dari detik kamu klik — padahal yang menentukan keputusan justru apa yang
sudah terjadi sejak pagi.

Hanya emiten yang sedang dibuka yang dilacak, dan feed live hanya masuk kalau tanggal
yang ditampilkan memang hari berjalan — kalau tidak, membuka detail tanggal lampau akan
tercampur transaksi hari ini. Pola "pantau beberapa emiten" ini yang nanti dipakai OB2,
yang memang per simbol dan tidak scalable ke semua emiten.

```
GET /api/symbol?code=BBCA[&date=YYYY-MM-DD][&reload=1]
GET /api/unwatch?code=BBCA        (dipanggil halaman saat panel ditutup)
```

## Kelengkapan data — apa yang rusak kalau perekaman bolong

Angka kumulatif hanya benar kalau arsip hari itu mulai dari pembukaan. Kalau scanner baru
login jam 11:45, delta kumulatif sebenarnya "sejak 11:45", bukan sejak 09:00 — dan itu
**salah**, bukan sekadar kurang lengkap. Ada asimetri yang penting diketahui:

| Ikut rusak kalau bolong | Tetap benar |
|---|---|
| delta kumulatif, footprint | **VWAP** (`[17]`) |
| high/low, total volume & nilai | harga, %, tick |
| ringkasan riwayat per emiten | sisi agresor per transaksi |

VWAP dihitung server IPOT sejak pembukaan dan dikirim utuh di **setiap** transaksi, jadi
ia benar sejak transaksi pertama yang kita terima, seberapa pun telatnya. Itu sebabnya
VWAP jadi jangkar yang bisa dipercaya walau arsipnya bolong.

Panel detail menyebutkan ini sendiri: judul grafiknya berbunyi "sejak HH:MM" (bukan
"sejak pembukaan"), dan kalau perekaman mulai setelah 09:01 muncul pil merah di header
modal, di samping kode emiten — sengaja di sana dan bukan di atas grafik, karena di situ
ia mendorong grafik turun setiap kali panel dibuka. Kalimat penjelasnya ada di tooltip.
Server mengirim `recordedFrom` — jam transaksi pertama di arsip hari itu.

**Mengukur lubang.** Field `[5]` (nomor urut transaksi) naik terus, jadi lompatan di sana
menandakan transaksi yang tidak terekam:

```bash
python3 - <<'EOF'
rows=[l.split('|') for l in open('logs/lt/2026-08-13.txt') if l.strip()]
seq=[int(r[5]) for r in rows]
gaps=[b-a-1 for a,b in zip(seq,seq[1:]) if b-a>1]
print(f'{len(rows):,} transaksi · rentang seq {max(seq)-min(seq):,} · {sum(gaps):,} nomor terlewat')
EOF
```

Arsip `2026-08-12` (hasil pemulihan dari `frames.jsonl` yang dibatasi 20 MB) punya 108.374
nomor terlewat, termasuk lubang 10 menit penuh di 15:50–15:59 — contoh nyata kenapa
indikator ini perlu. Catatan: belum dipastikan apakah semua nomor yang terlewat itu benar
transaksi hilang, atau seq global juga mencakup event yang tidak kita subscribe. Butuh satu
hari penuh untuk memastikan.

**Penyebab lubang, urut dari yang paling sering:**

1. Belum scan QR saat bursa buka (lihat peringatan di bawah).
2. **Restart collector** — memutus sesi login, dan token lama ditolak IPOT, jadi wajib scan
   ulang. Ini penyebab utama pada 13 Agu 2026 (tiga kejadian, ~3,5 jam), dan alasan
   collector dipisah dari app. Restart **app** tidak berpengaruh — sudah diuji: PID
   collector tetap sama dan ia hanya mencatat `app tersambung: 0` lalu `1`.
3. Reconnect di tengah sesi (watchdog) — biasanya singkat.

Setelah app restart, jendela burst & tekanan diisi ulang dari arsip (`warmup` di `app.ts`)
supaya panel tekanan tidak kosong beberapa menit. Statistik "masuk/lolos" sengaja tidak
ikut diisi — itu menghitung sesi app ini, bukan sejarah arsip.

## QR di-scan tapi tidak pernah login

Gejalanya membingungkan: di HP muncul konfirmasi berhasil, tapi scanner tetap di layar QR
dan tidak ada satu pun frame balasan dari IPOT — bukan penolakan, bukan error, **diam
total**. Terjadi 14 Agu 2026.

Penyebabnya: **`appsession` yang basi**, bukan socket yang mati. Collector waktu itu sudah
jalan ~16 jam tanpa login; koneksi WebSocket-nya masih hidup dan masih menerima notifikasi
IDX seperti biasa, tapi token `appsession` yang dipakai saat menyambung sudah tidak sah
untuk operasi login. Begitu collector di-restart (yang berarti `fetchAppSession()` baru),
scan pertama langsung berhasil.

Batas persisnya tidak diketahui — yang terbukti hanya: **28 menit masih bisa, ~16 jam
tidak**. Karena itu `collector.ts` sekarang menyambung ulang lebih dulu kalau diminta QR
sementara koneksinya sudah lebih tua dari 5 menit dan belum login (`STALE_LOGIN_MS`).
Ambangnya sengaja jauh lebih ketat daripada perlu: reconnect makan 2–3 detik, sementara
gagal login diam-diam memakan berjam-jam data.

Kalau gejala ini muncul lagi, cek dua hal sebelum menduga yang lain:

```bash
# 1. Umur proses collector — makin tua makin curiga
ps -o etime= -p $(systemctl --user show whale-collector.service -p MainPID --value)

# 2. Frame yang benar-benar datang setelah QR dikirim (LT tidak ikut di sini,
#    jadi frame login pasti terlihat kalau memang ada)
tail -5 logs/frames.jsonl
```

## Peringatan belum login

Bursa buka tapi scanner tidak login berarti `subscribe LT` tidak pernah terkirim, jadi
tidak ada transaksi yang terekam — dan itu dulu terjadi tanpa tanda apa pun.

**Pre-opening (08:40–09:00):** diingatkan sekali per hari, sebelum bursa buka. Ini yang
mencegah lubang di awal hari — begitu 09:00 lewat tanpa login, menit-menit pertama hilang
dan tidak bisa diambil kembali dari mana pun.

**Setelah bursa buka**, kalau belum login lebih dari 2 menit:

- peringatan mencolok di journal, diulang tiap 10 menit dengan hitungan menit yang hilang
- **notifikasi desktop** (`notify-send`, urgency critical) — satu-satunya jalur yang sampai
  saat kamu tidak sedang melihat halaman maupun terminal
- banner merah di layar QR yang menyebutkan berapa menit sudah tidak terekam

Saat akhirnya login, journal mencatat berapa lama yang hilang supaya jejaknya tetap ada.
Notifikasi gagal (mis. `notify-send` tidak ada, atau service tidak dapat D-Bus session)
diabaikan diam-diam — scanner tidak boleh berhenti karena notifikasi.

## Diketahui belum ada

- Sesi disimpan di `logs/session.json`, tapi IPOT menolak token lama saat reconnect
  (`#removeAuthToken`) — restart tetap butuh scan QR ulang. Kodenya sudah siap kalau
  perilaku server berubah. Ini **akar masalah** yang membuat 1,5 jam sesi 1 hilang pada
  13 Agu 2026; sekarang setidaknya ada peringatannya (lihat di atas), tapi scan QR manual
  tetap perlu tiap restart.
- Baseline relatif per emiten (padanan slider "kepekaan anomali") belum ada — burst masih
  ambang absolut. Arsip harian sekarang bisa jadi sumber data historisnya.
- OB2 (orderbook) untuk **spread** dan **offer wall** — per simbol, jadi tidak scalable
  untuk memindai semua ~686 emiten sekaligus. Untuk sisi agresor, OB2 **tidak lagi
  dibutuhkan** (sudah ada di feed LT).
- Arti angka di dalam slot `[13]`/`[14]` (kemungkinan nomor order) — butuh arsip sehari
  penuh, jalankan `tools/analyze-lt.ts`.

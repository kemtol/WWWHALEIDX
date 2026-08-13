# Whale Scanner — MVP

Login QR ke IPOT + running trade live di halaman lokal.

## Jalankan manual (dev)

```bash
cd scanner
npm install     # sekali saja
npm start
```

1. Buka <http://127.0.0.1:3000> — halaman QR tampil penuh (juga dicetak di terminal sebagai cadangan).
2. Di HP: **IPOT → Member Area → Security → Login to IPOT Web** → scan QR (berlaku 60 detik).
3. Login berhasil → halaman otomatis pindah ke dashboard, running trade mengalir.
4. Tombol **Logout** di dashboard mengembalikan ke layar QR (memutus sesi di server, bukan cuma sembunyikan tampilan).

Tombol terminal saat berjalan: `r` QR baru · `s` subscribe manual · `q` keluar.

## Jalan otomatis + domain lokal (`https://whale.scanner.local`)

Server jalan sebagai systemd `--user` service (`~/.config/systemd/user/whale-scanner.service`),
auto-start setiap login/restart, auto-restart kalau crash. Diakses lewat domain lokal
dengan HTTPS asli (bukan "Not Secure") pakai sertifikat [mkcert](https://github.com/FiloSottile/mkcert).

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

# 5. Service systemd
systemctl --user daemon-reload
systemctl --user enable --now whale-scanner.service
```

Setelah itu: buka <https://whale.scanner.local> — kalau Chrome/Firefox baru saja di-install
ulang CA-nya, restart browser dulu supaya sertifikatnya dipercaya.

Cek status / log:
```bash
systemctl --user status whale-scanner.service
journalctl --user -u whale-scanner.service -f
```

Sertifikat `certs/*.pem` berlaku ~2 tahun (lihat tanggal exact: `openssl x509 -in certs/whale.scanner.local.pem -noout -enddate`),
tidak di-commit ke git (private key). Kalau expired, ulangi langkah 2 lalu `systemctl --user restart whale-scanner.service`.

## Struktur

```
src/ipot.ts     koneksi WebSocket IPOT, login QR, subscribe, parse pipe
src/filters.ts  filter transaksi, deteksi burst, tekanan HAKA/HAKI
src/archive.ts  arsip transaksi harian (logs/lt/), rotasi + retensi
src/history.ts  query rentang waktu dari arsip + ringkasan per emiten
src/server.ts   http lokal + push WebSocket ke browser + /api/*
src/index.ts    orkestrasi (reconnect, watchdog, sesi, logout, arsip)
public/index.html  halaman login (QR) + dashboard 3 kolom + mode riwayat
tools/analyze-lt.ts   bedah field feed dari arsip satu hari
tools/backfill-lt.ts  pemulihan: tarik payload LT lama dari frames.jsonl
logs/lt/YYYY-MM-DD.txt  arsip transaksi, satu payload mentah per baris
logs/frames.jsonl       frame protokol NON-LT, dibatasi ~20MB (auto-rotasi)
```

## Arsip harian & riwayat

Setiap transaksi ditulis apa adanya ke `logs/lt/YYYY-MM-DD.txt` — satu payload pipe
per baris, sebelum disaring filter apa pun. Sekitar **72 byte per transaksi, ~25 MB
per hari bursa penuh**. Retensi default 30 hari (`ARCHIVE_DAYS`).

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

## Peringatan belum login

Bursa buka tapi scanner tidak login berarti `subscribe LT` tidak pernah terkirim, jadi
tidak ada transaksi yang terekam — dan itu dulu terjadi tanpa tanda apa pun. Sekarang,
kalau bursa buka dan scanner belum login lebih dari 2 menit:

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

# PRD: IDX Whale Scanner

**Stack:** Node.js + TypeScript, UI browser lokal (`scanner/`)
**Target:** tool pribadi, jalan permanen di komputer sendiri — bukan produk yang di-deploy
ke server luar. Diakses via `https://whale.scanner.local` (auto-start lewat systemd
`--user` service), lihat [`scanner/README.md`](../scanner/README.md#jalan-otomatis--domain-lokal-httpswhalescannerlocal).

## 1. Tujuan

Scanner yang menampilkan running trade IDX secara live lewat feed IPOT, dengan filter
untuk memisahkan transaksi yang "layak dilihat" (nilai besar, burst, emiten tertentu)
dari derasnya seluruh transaksi bursa — dan memberi indikasi kasar arah tekanan beli vs
jual (HAKA/HAKI) per emiten. Intinya: alat bantu melihat saham apa yang lagi "rame",
bukan sistem alert otomatis.

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

```
IPOT WebSocket (socketcluster) ──> scanner/src/ipot.ts   (koneksi, login QR, parse LT)
                                          │
                          ┌───────────────┴───────────────┐
                          │                               │
              scanner/src/filters.ts          scanner/src/archive.ts
              (filter + burst + HAKA/HAKI)     (arsip harian logs/lt/)
                          │                               │
                          │                    scanner/src/history.ts
                          │                    (query rentang + ringkasan)
                          └───────────────┬───────────────┘
                                          │
                                    scanner/src/server.ts  (broadcast + /api/*)
                                          │
                                    scanner/public/index.html (login → dashboard → riwayat)
```

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
- **Logout** — memutus sesi di server (bukan cuma sembunyikan tampilan), kembali ke
  layar QR.

## 5. Yang sengaja belum dikerjakan

- Sesi persisten lintas restart — kodenya sudah ada tapi IPOT menolak token lama
  (`#removeAuthToken`), jadi tiap restart tetap scan ulang. Sudah terbukti memakan korban:
  13 Agu 2026, 1,5 jam data sesi 1 hilang karena tidak ada yang scan QR setelah restart.
  Peringatannya kini ada, tapi akar masalahnya belum hilang.
- Arti nilai di dalam slot `[13]`/`[14]` (kemungkinan nomor order) — butuh arsip sehari
  penuh, jalankan `scanner/tools/analyze-lt.ts`.
- Baseline relatif per emiten (deteksi anomali yang menyesuaikan diri terhadap
  keramaian normal tiap saham, bukan ambang absolut).
- OB2 (orderbook) untuk **spread** dan **offer wall** — per simbol, jadi tidak scalable
  untuk memindai seluruh ~686 emiten sekaligus. Untuk sisi agresor OB2 tidak lagi
  dibutuhkan.

## 6. Referensi

- [`scanner/README.md`](../scanner/README.md) — cara jalan (dev & deploy permanen),
  protokol IPOT, format pipe LT, setup domain lokal + HTTPS.

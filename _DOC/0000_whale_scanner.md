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
                                    scanner/src/filters.ts (filter + burst + HAKA/HAKI)
                                          │
                                    scanner/src/server.ts  (broadcast ke browser)
                                          │
                                    scanner/public/index.html (halaman login → dashboard)
```

Detail protokol, format pipe LT yang terverifikasi, dan cara jalan — ada di
[`scanner/README.md`](../scanner/README.md), supaya tidak dobel dan gampang basi.

## 4. Fitur inti

- **Login QR** — scan dari HP (IPOT → Member Area → Security → Login to IPOT Web),
  tanpa endpoint HTTP terpisah, semua lewat satu WebSocket.
- **Live trade** — mengalir ke tabel begitu login berhasil, halaman otomatis pindah
  dari layar QR ke dashboard.
- **Filter transaksi** — emiten (watchlist), nilai minimum, lot minimum, papan
  (RG/NG/TN), rentang harga, rentang % perubahan, jam, dan **burst** (N transaksi
  dalam T detik, jendela bergulir per emiten).
- **Tekanan HAKA/HAKI** — dihitung dari tick rule (uptick = agresor beli, downtick =
  agresor jual) pada feed LT saja, tanpa OB2. Hanya transaksi ber-bukti (`tick != 0`)
  yang dihitung; tidak menebak arah transaksi flat-tick, karena terbukti membalik
  kesimpulan pada 28% emiten kalau ditebak lewat pewarisan arah sebelumnya.
- **Logout** — memutus sesi di server (bukan cuma sembunyikan tampilan), kembali ke
  layar QR.

## 5. Yang sengaja belum dikerjakan

- Sesi persisten lintas restart — kodenya sudah ada tapi IPOT menolak token lama
  (`#removeAuthToken`), jadi tiap restart tetap scan ulang.
- Baseline relatif per emiten (deteksi anomali yang menyesuaikan diri terhadap
  keramaian normal tiap saham, bukan ambang absolut).
- OB2 (orderbook) untuk aggressor asli — per simbol, jadi tidak scalable untuk
  memindai seluruh ~686 emiten sekaligus. HAKA/HAKI saat ini tetap tebakan tick rule.

## 6. Referensi

- [`scanner/README.md`](../scanner/README.md) — cara jalan (dev & deploy permanen),
  protokol IPOT, format pipe LT, setup domain lokal + HTTPS.

# WWWHALEIDX — IDX Whale Scanner

Scanner running trade IDX untuk **scalping harian**. Menjawab satu pertanyaan tiap hari
bursa: *saham apa yang hari ini layak ditradingkan untuk target 1,5–2%?*

Implementasi ada di **[`scanner/`](scanner/README.md)** — Node.js/TypeScript.

## Status: sudah deployed, bukan cuma dev

Di komputer ini scanner **sudah jalan permanen**:

- **Dua** systemd `--user` service, unit-nya di `~/.config/systemd/user/` (di luar repo):
  `whale-collector.service` (sesi IPOT + arsip) dan `whale-app.service` (UI + analitik).
  Yang lama `whale-scanner.service` sudah di-disable.
- Diakses via `https://whale.scanner.local` — sertifikat lokal asli (mkcert).

**Aturan operasional yang penting:** `whale-app` boleh direstart kapan saja, tapi
**hindari merestart `whale-collector` saat bursa buka** — IPOT menolak token sesi yang
dipulihkan, jadi restart menuntut scan QR ulang dan transaksi tidak terekam sampai ada
yang scan. Ini pernah memakan ~3,5 jam data dalam sehari.

```bash
systemctl --user status whale-collector.service whale-app.service
journalctl --user -u whale-collector.service -f   # login, sesi, arsip
```

Dev cepat tanpa TLS: `cd scanner && npm run collector` + `npm run app`
(`http://127.0.0.1:3000`). Setup ulang lengkap ada di
**[`scanner/README.md`](scanner/README.md#jalan-otomatis--domain-lokal-httpswhalescannerlocal)**.

## Isinya apa

| | |
|---|---|
| **Live trade + filter** | nilai, lot, papan, harga, %, vs VWAP, jam, burst |
| **HAKA/HAKI** | sisi agresor dibaca **langsung dari feed**, bukan tebakan tick rule |
| **Kandidat** | satu tabel peringkat: kandidat hari penuh + tekanan jendela 1m/5m/15m |
| **Detail per emiten** | footprint per harga, delta kumulatif, POC/value area, pita VWAP, opening range, divergensi, laju tape |
| **Arsip + riwayat** | tiap transaksi disimpan mentah per hari, bisa ditelusuri mundur |
| **Analisa AI** | DeepSeek menganalisa kandidat → pick dengan entry/invalidasi/target |
| **Percakapan sehari** | satu hari = satu benang; analisa lanjutan menjelaskan pick yang dikeluarkan, dan bisa ditanya lanjut lewat chat |

Semua penjelasan mendalam — protokol IPOT, format pipe LT yang terverifikasi, matematika
HAKA/HAKI, cara membaca tiap indikator, dan alasan di balik keputusan rancangan — ada di
**[`scanner/README.md`](scanner/README.md)**. Dokumen itu panjang dan sengaja detail;
baca itu sebelum mengubah apa pun.

`_DOC/0000_whale_scanner.md` adalah PRD-nya: tujuan, arah, dan apa yang sengaja belum
dikerjakan. `_DOC/0001_protokol_ipot_lengkap.md` memuat kosakata perintah IPOT hasil
tapping klien resmi — bentuk langganan OB2/SS2/BAR1 dan query broker summary yang belum
kita pakai, plus daftar klaim keliru yang beredar di project lain.

## Riwayat singkat

Project ini dimulai dengan Rust, tapi Rust-nya **tidak pernah menerima data** —
subscribe ke feed `mi`/`LT` selalu dibalas `NOSERVICE` karena butuh sesi IPOT yang
sudah login, dan versi Rust tidak punya alur login sama sekali.

Setelah akar masalah itu ketemu (login QR lewat WebSocket, terverifikasi dari frame
browser asli), project di-porting penuh ke Node/TypeScript — lebih cocok untuk tool
lokal, UI browser gratis (sorting/filter/warna) tanpa perlu terminal UI. Kode Rust-nya
sudah dihapus total; riwayatnya masih ada di `git log` kalau perlu ditengok.

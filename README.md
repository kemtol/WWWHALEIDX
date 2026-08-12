# WWWHALEIDX — IDX Whale Scanner

Implementasi ada di **[`scanner/`](scanner/README.md)** — Node.js/TypeScript.
Dev cepat: `cd scanner && npm install && npm start` (buka `http://127.0.0.1:3000`).

## Status: sudah deployed, bukan cuma dev

Di komputer ini scanner **sudah jalan permanen**, bukan sekadar `npm start` manual:

- Auto-start tiap boot/restart lewat systemd `--user` service (`whale-scanner.service`,
  unit-nya di `~/.config/systemd/user/`, di luar repo ini).
- Diakses via `https://whale.scanner.local` — sertifikat lokal asli (mkcert), bukan
  `http://127.0.0.1:3000`.

Detail lengkap cara setup ulang (kalau pindah mesin atau sertifikat expired) ada di
**[`scanner/README.md`](scanner/README.md#jalan-otomatis--domain-lokal-httpswhalescannerlocal)**.

## Riwayat singkat

Project ini dimulai dengan Rust, tapi Rust-nya **tidak pernah menerima data** —
subscribe ke feed `mi`/`LT` selalu dibalas `NOSERVICE` karena butuh sesi IPOT yang
sudah login, dan versi Rust tidak punya alur login sama sekali.

Setelah akar masalah itu ketemu (login QR lewat WebSocket, terverifikasi dari frame
browser asli), project di-porting penuh ke Node/TypeScript di `scanner/` — lebih cocok
untuk tool lokal, UI browser gratis (sorting/filter/warna) tanpa perlu terminal UI.
Kode Rust-nya sudah dihapus total; riwayatnya masih ada di git log kalau perlu ditengok.

`_DOC/` menyimpan dokumen perencanaan awal (PRD, sketsa UI) — konsepnya masih relevan
meski implementasinya sudah berpindah ke Node.

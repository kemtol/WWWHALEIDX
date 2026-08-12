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
src/server.ts   http lokal + push WebSocket ke browser
src/index.ts    orkestrasi (reconnect, watchdog, sesi, logout)
public/index.html  halaman login (QR) + dashboard 3 kolom
logs/frames.jsonl  semua frame WS, dibatasi ~20MB (auto-rotasi)
```

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
| 15 | perubahan harga | = `[6]-[12]`, cocok 30941/30941 |
| 18 | % perubahan | dibulatkan ke bawah, cocok 30941/30941 |

`[0]`=B, `[2]`=0, `[19]`=1 selalu konstan. `[8]`–`[11]` selalu kosong.
`[13] [14] [16] [17]` belum jelas.

**Feed LT tidak memuat sisi agresor (beli/jual)** — field `[0]` konstan dan kode broker
kosong. Filter HAKA/aggressor, spread, dan offer wall butuh subscribe orderbook (`OB2`),
belum dikerjakan.

## Filter yang tersedia

Emiten (watchlist + preset LQ45) · nilai minimum · lot minimum · papan RG/NG/TN ·
rentang harga · rentang % perubahan · jam · burst (N transaksi dalam T detik).

Burst dihitung dari **semua** transaksi emiten, bukan hanya yang lolos filter — kalau
tidak, ambang nilai besar membuat burst mustahil terpicu.

## Tekanan HAKA/HAKI

Feed LT tidak punya sisi agresor eksplisit, jadi arah ditebak lewat tick rule pada field
`[16]`: uptick = agresor beli (HAKA), downtick = agresor jual (HAKI). Transaksi di harga
sama (`tick == 0`) **tidak** ditebak arahnya (dulu diwariskan dari transaksi sebelumnya —
terbukti membalik kesimpulan pada 28% emiten, jadi dihapus). Panel pressure hanya
menghitung transaksi ber-bukti, dan emiten dengan bukti < 10 transaksi disembunyikan
dari peringkat.

## Diketahui belum ada

- Sesi disimpan di `logs/session.json`, tapi IPOT menolak token lama saat reconnect
  (`#removeAuthToken`) — restart tetap butuh scan QR ulang. Kodenya sudah siap kalau
  perilaku server berubah.
- Baseline relatif per emiten (padanan slider "kepekaan anomali") belum ada — burst masih
  ambang absolut.
- OB2 (orderbook) untuk aggressor asli, bukan tebakan tick rule — sengaja ditunda, per
  simbol jadi tidak scalable untuk memindai semua ~686 emiten sekaligus.

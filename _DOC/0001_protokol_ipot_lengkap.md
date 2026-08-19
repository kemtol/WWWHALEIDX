# Kosakata protokol IPOT — hasil tapping klien resmi

**Sumber:** `SSSAHAM/electron/AlgoSaham/data/ws-dump.json` (306 KB, 726 frame, 31 Mar 2026)
— rekaman HTTP+WebSocket dari sesi **aplikasi web IPOT resmi**, bukan tulisan tangan.
Karena isinya frame `SEND` milik klien resmi, bentuk perintah di sini **otoritatif**.

Proyek asalnya (`SSSAHAM`, `SSSAHAM_SERVICE`) ada di luar repo ini, di balik symlink
`~/Projects/SSSAHAM → /home/mkemalw/ssd-offload/SSSAHAM`. `find` tanpa `-L` tidak akan
menemukannya — itu sebabnya dulu sempat disimpulkan tidak ada.

> **Peringatan.** Kode dan dokumen tulisan tangan di SSSAHAM memuat beberapa kesalahan
> yang sudah kita buktikan salah (lihat bagian terakhir). Yang bisa dipercaya dari sana
> hanyalah **dump mentah** ini. Jangan menyalin kodenya.

---

## 1. Yang mengonfirmasi implementasi kita

Klien resmi mengirim Live Trade **tanpa `code` dan tanpa `subsid`**:

```json
{"cmd":"subscribe","service":"mi","rtype":"LT","subscribe":true}
```

Persis seperti `subscribeLiveTrade()` di `scanner/src/ipot.ts`. Ini bukti independen
kedua (yang pertama: tangkapan frame halaman marketlive) bahwa menambahkan `code:"*"`
dan `subsid` — seperti dilakukan versi Rust lama dan kedua implementasi SSSAHAM —
memang yang membuat server membalas `NOSERVICE`.

**Pola umumnya:** langganan *global* tidak memakai `code`/`subsid`; langganan *per
simbol* wajib memakai keduanya.

---

## 2. Langganan yang belum kita pakai

Semua di bawah `service: "mi"`, dibungkus
`{"event":"cmd","data":{"cmdid":N,"param":{…}},"cid":M}`.

| rtype | Parameter | Isi |
|---|---|---|
| `SS2` | `code`, `subsid` | Snapshot saham: prev/high/low/last, volume, value, frekuensi, bid/ask berikut volumenya, total buy & sell volume |
| `OB2` | `code`, **`level:10`**, `subsid` (hex acak) | Orderbook 10 tingkat |
| `AUC` | `code`, `subsid` (hex acak) | Data lelang |
| `BAR1` | `code`, `resolution:"1"`, `subsid`, `subscribe:true` | Candle OHLCV 1 menit |
| `IDX` | `code:"COMPOSITE"`, `subsid` | IHSG |
| `ID` | `code:"*"`, `subsid`, `subscribe:true` | Seluruh indeks |
| `FT` | `code:"*"`, `subsid`, `subscribe:true` | Futures |
| `XSS_R` | `code:"R6\|COMPOSITE\|dsc\|val"`, `subsid` | **Peringkat pasar** — tersusun menurut nilai, menurun |
| `TREND_R10_5` · `TREND_R10_LIVE` | `code:"frqNWR"`, `subsid`, `subscribe:true` | Peringkat tren |

`subsid` bebas dipilih klien; yang resmi memakai pola berbeda-beda (`ml-TLKM`,
`ml-idx`, `IDX.COMPOSITE_#_1`, atau hex acak 10 karakter).

---

## 3. Query — bukan langganan, sekali tanya sekali jawab

```json
{"event":"cmd","data":{"cmdid":N,"param":{"cmd":"query","service":"mi",
  "param":{"source":"jsx","index":"<index>","args":{…}}}},"cid":M}
```

| service | index | args | Isi |
|---|---|---|---|
| `mi` | `stockname` | `{"code":"*"}` | Nama seluruh emiten |
| `mi` | `prevprice` | `{"code":"*"}` | Penutupan kemarin **seluruh emiten sekaligus** |
| `mi` | `sector` | `{"code":["TLKM"]}` | Sektor per emiten |
| `mi` | `otherdata` | `{"code":"*"}` | (belum diperiksa) |
| `midata` | `en_qu_TradedSummary` | `["TLKM"]` | Ringkasan perdagangan |
| `midata` | `en_qu_top_bs` | `["s","TLKM","","%","%","2026-3-31","2026-3-31"]` | **Broker summary** — bandarmologi, per tanggal |
| `midata` | `NEARCA` | `[]` | (belum diperiksa) |

Plus perintah tanpa `service`: `getServerTime`, `resolveSymbol`, dan `getBars`
(candle historis, memakai `symbolInfo` bergaya TradingView lengkap dengan
`supportedResolutions: ["1","15","D"]`).

**Yang paling menarik untuk kita:** `prevprice` (`code:"*"`) memberi penutupan kemarin
seluruh emiten dalam satu tanya — sekarang kita hanya tahu prevClose emiten yang
kebetulan bertransaksi. Dan `en_qu_top_bs` adalah broker summary, sesuatu yang tidak
bisa diturunkan dari feed LT sama sekali.

---

## 4. Yang SALAH di dokumen dan kode SSSAHAM

Diperiksa terhadap arsip kita sendiri; jangan disalin.

| Klaim mereka | Kenyataan |
|---|---|
| LT: `code:"*"` + `subsid` | Membuat server membalas `NOSERVICE`. Klien resmi tidak mengirim keduanya. |
| Format pipe `YYYYMMDD\|HHMMSS\|TICKER\|…` | Field `[0]` selalu `"B"`, bukan tanggal. Parser mereka tidak akan pernah cocok. |
| `[17]` = best ask | `[17]` = **VWAP**. Dokumen mereka sendiri membantahnya: contoh `notif` menunjukkan `pavg: 5095` untuk PTRO, sama persis dengan nilai `[17]` di contoh LT mereka. |
| `[14]` = volume kumulatif | **Tidak mungkin.** Diuji atas arsip 18 Agu 2026: GPRA turun dari 3.041.771 ke 1.047.880. Volume kumulatif tidak pernah turun. |
| `[13]` = sisi (`00`/`12`/`21`) | Nilainya angka 7 digit, bukan kode dua digit. Yang menandakan sisi adalah **slot mana yang terisi**, bukan nilainya. |

### Arti nilai `[13]`/`[14]` — dugaan terkuat sejauh ini

Bukan volume kumulatif, dan bukan penghitung global yang dibaca "sekarang": pada detik
yang sama, nilai lintas emiten tersebar dari 4.486 sampai 4.066.175.

Sebarannya justru khas **nomor order**: satu transaksi menabrak order yang sudah
tergeletak di buku sejak pagi (nomor kecil) atau yang baru masuk (nomor besar). Itu juga
menjelaskan dua hal yang sudah lama kita amati — nilainya tidak monoton dalam satu
emiten, dan sering berulang sama persis saat satu order agresor memakan beberapa order
lawan sekaligus.

Masih dugaan, bukan bukti. Yang **sudah** terbukti dan dipakai sistem: slot mana yang
terisi menandakan sisi agresor (99,7% konsisten atas 45.110 transaksi) — dan itu tidak
bergantung pada arti nilainya.

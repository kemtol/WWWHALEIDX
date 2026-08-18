Ini analisa LANJUTAN di hari yang sama. Di atas ada analisa dan pembicaraan kita
sebelumnya hari ini — kamu sudah pernah memberi rekomendasi, dan sekarang datanya
diperbarui.

Tugasmu sama: pilih emiten yang paling layak di-scalp LONG saat ini juga, target
realistis 1,5–2%. Batasan dan arti field persis sama seperti di atas.

Tambahan yang WAJIB untuk analisa lanjutan:

- Isi `perubahan`: apa yang berubah sejak analisa sebelumnya. Terutama **emiten yang
  tadi kamu rekomendasikan tapi sekarang tidak lagi** — sebutkan namanya dan kenapa
  dikeluarkan (target tercapai? invalidasi kena? tekanan belinya habis? tergeser yang
  lebih baik?). Pembacanya melihat daftar yang berubah dan berhak tahu alasannya.
- Kalau sebuah pick masih bertahan dari analisa sebelumnya, katakan begitu di
  `alasan`-nya, dan sebutkan apakah setupnya menguat atau melemah.
- Kalau pick lama sudah kena invalidasi atau target, katakan terang-terangan. Jangan
  diam-diam menghilangkannya dari daftar.

Jangan mengulang seluruh isi analisa sebelumnya — cukup yang berubah.

Balas HANYA dengan JSON valid persis skema ini — tanpa markdown, tanpa teks lain:

{
  "pasar": "1-2 kalimat kondisi tape sekarang",
  "perubahan": "2-4 kalimat: apa yang berubah sejak analisa sebelumnya, termasuk pick yang dikeluarkan dan alasannya",
  "picks": [
    {
      "symbol": "XXXX",
      "setup": "nama setup singkat",
      "keyakinan": 3,
      "entry": 0,
      "invalidasi": 0,
      "target": 0,
      "alasan": "2-4 kalimat, jujur termasuk risikonya; sebut kalau ini lanjutan dari pick sebelumnya",
      "bukti": ["angka dari data yang jadi dasar"]
    }
  ],
  "dihindari": [
    { "symbol": "XXXX", "kenapa": "1 kalimat" }
  ]
}

DATA TERBARU:
{{DATA_JSON}}

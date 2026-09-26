# AGENTS.md

Dokumen ini berisi aturan kerja bagi setiap agen kecerdasan buatan (AI agent) — termasuk namun tidak terbatas pada Claude, GitHub Copilot, Cursor, atau agen sejenis lainnya — yang beroperasi di dalam repositori ini. Aturan ini mengikat terlepas dari platform atau vendor agen yang digunakan.

## 1. Tujuan

Dokumen ini menetapkan prinsip dan prosedur kerja standar agar agen AI:

1. Memahami maksud dan konteks permintaan pengguna secara menyeluruh sebelum bertindak.
2. Tidak melakukan eksekusi (perintah, perubahan berkas, atau pemanggilan alat eksternal) tanpa dasar yang jelas.
3. Mengomunikasikan rencana tindakan kepada pengguna sebelum mengeksekusinya, khususnya untuk aksi yang berdampak atau tidak dapat dibatalkan dengan mudah.

## 2. Prinsip Utama

| No. | Prinsip | Penjelasan |
|-----|---------|------------|
| 2.1 | **Pahami sebelum bertindak** | Permintaan seperti "cek", "pelajari", "jelaskan", "lihat", atau "review" berarti membaca dan menganalisis, bukan izin untuk mengeksekusi perintah, membuat berkas, atau mengubah apa pun. |
| 2.2 | **Analisis adalah default** | Jika terdapat keraguan antara menganalisis atau mengeksekusi suatu permintaan, agen wajib memilih untuk menganalisis terlebih dahulu. |
| 2.3 | **Efisiensi bukan alasan untuk mengeksekusi tanpa izin** | Anggapan bahwa eksekusi langsung akan "mempercepat penyelesaian tugas" tidak menggugurkan kewajiban untuk memahami konteks dan meminta konfirmasi terlebih dahulu. |
| 2.4 | **Transparansi tindakan** | Setiap rencana eksekusi harus disampaikan secara eksplisit kepada pengguna: apa yang akan dijalankan, mengapa diperlukan, dan apa dampaknya. |

## 3. Alur Kerja Standar

Setiap permintaan pengguna wajib diproses melalui tahapan berikut, secara berurutan:

1. **Analisis Permintaan** — Identifikasi maksud sebenarnya dari permintaan pengguna. Permintaan "periksa berkas X" berbeda dengan "perbaiki berkas X", dan berbeda pula dengan "jalankan X".
2. **Pahami Konteks** — Baca berkas, kode, atau dokumentasi terkait sebelum menarik kesimpulan atau memberikan rekomendasi. Kesimpulan tidak boleh didasarkan pada asumsi atau tebakan.
3. **Ajukan Rencana Eksekusi (bila diperlukan)** — Apabila tugas memerlukan eksekusi (menjalankan alat baris perintah, proses build, pembuatan berkas, instalasi paket, dan sejenisnya), agen wajib menjelaskan rencana tersebut kepada pengguna dan menunggu konfirmasi sebelum melanjutkan.
4. **Eksekusi dan Pembersihan** — Setelah memperoleh konfirmasi, agen dapat mengeksekusi rencana tersebut. Berkas atau artefak sementara yang dihasilkan semata-mata untuk keperluan analisis (misalnya berkas laporan atau hasil ekspor) wajib dibersihkan setelah tidak lagi diperlukan, agar tidak meninggalkan jejak pada direktori kerja.

## 4. Klasifikasi Aksi

### 4.1 Aksi yang Dapat Dilakukan Tanpa Konfirmasi

Aksi bersifat *read-only* (hanya membaca, tidak mengubah keadaan apa pun) dapat dilakukan secara langsung tanpa perlu menawarkan terlebih dahulu:

- Membaca isi berkas.
- Mencari (grep/search) isi berkas atau struktur direktori.
- Memeriksa status version control yang bersifat non-destruktif, seperti `git status`, `git diff`, dan `git log`.

### 4.2 Aksi yang Wajib Dikonfirmasi Terlebih Dahulu

Aksi yang mengubah keadaan repositori, meninggalkan artefak baru, atau memerlukan alat eksternal wajib ditawarkan dan dikonfirmasi terlebih dahulu oleh pengguna sebelum dijalankan:

- Menjalankan alat baris perintah atau perangkat lunak eksternal (misalnya `kicad-cli`, compiler, atau skrip build).
- Menghasilkan berkas baru (laporan, hasil ekspor, netlist, dan sejenisnya), termasuk yang ditujukan semata-mata untuk membantu proses analisis.
- Mengubah, menulis, atau menghapus berkas apa pun di dalam repositori.
- Menjalankan operasi version control yang mengubah keadaan, seperti `git add`, `git commit`, atau `git push`.
- Memasang atau mencabut dependensi maupun paket perangkat lunak.

Apabila eksekusi ternyata diperlukan untuk dapat menjawab suatu pertanyaan analitis (misalnya memerlukan alat tertentu untuk membaca struktur berkas biner atau format tertutup), agen tetap wajib menawarkan rencana tersebut terlebih dahulu dan menjelaskan alasannya — kecuali pengguna telah memberikan izin eksplisit di awal permintaan (misalnya dengan menyatakan "gas", "langsung saja", atau pernyataan setara).

## 5. Konteks Proyek

Proyek **Smart Doorlock Kos ISK** merupakan sistem kunci pintu pintar (smart doorlock) berbasis mikrokontroler ESP32-C3, yang dikendalikan melalui protokol ESP-NOW dan terintegrasi dengan Firebase. Struktur repositori adalah sebagai berikut:

| Direktori | Isi |
|-----------|-----|
| `Hardware/` | Desain elektronik berbasis KiCad — skematik dan PCB untuk modul Doorlock (ESP32-C3, motor driver DRV8833, buck converter Mini560) serta modul Gateway. |
| `Firmware/` | Kode firmware ESP32, dikelola dengan PlatformIO. |
| `Document/` | Dokumentasi proyek, termasuk [Git Dictionary](Document/Documentation/Git%20Dictionary.md) yang berisi konvensi penulisan pesan commit. |

## 6. Catatan Teknis Tambahan

- Berkas dengan ekstensi `.kicad_sch` dan `.kicad_pro` merupakan berkas berbasis teks (format S-expression) dan dapat dibaca langsung tanpa perlu membuka aplikasi KiCad. Pembacaan berkas secara langsung harus diutamakan sebelum mempertimbangkan penggunaan alat eksternal.

## 7. Gaya Komunikasi

Komunikasi kepada pengguna hendaknya bersifat ringkas, langsung pada inti permasalahan, dan menghindari penjelasan yang tidak diminta atau di luar konteks pertanyaan.

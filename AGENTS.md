# AGENTS.md

Aturan main buat AI agent (Claude, Copilot, dst) yang kerja di repo ini.

## Prinsip Utama

**Pahami dulu, baru eksekusi.** Kalau user cuma minta "cek", "pelajarin", "jelasin", "liat", atau "review" sesuatu — itu artinya **baca & analisis**, bukan izin buat langsung jalanin command, generate file, atau ubah apapun.

Jangan asumsi "biar cepet kelar" = "langsung eksekusi". Kalau ragu antara *analisis* atau *eksekusi*, defaultnya selalu ke analisis dulu.

## Alur Kerja yang Diharapkan

1. **Analisis permintaan** — pahami apa yang sebenernya user mau. "Cek file X" beda sama "benerin file X" beda lagi sama "jalanin X".
2. **Pahami konteks** — baca file/kode yang relevan dulu sebelum nyimpulkan atau ngasih saran. Jangan asal generate jawaban dari tebakan.
3. **Kalau butuh eksekusi** (jalanin CLI tool, build, generate artifact, ubah file, install package, dll) — **tawarin dulu ke user**: jelasin apa yang mau dijalanin, kenapa, dan apa efeknya. Tunggu konfirmasi.
4. **Eksekusi setelah dikonfirmasi**, dan beresin/bersihin artifact sementara yang dibikin selama proses (misal file report/export yang cuma dipake buat analisis) — jangan nyampah ke working directory.

## Kapan Boleh Langsung Jalan (Tanpa Nanya Dulu)

Aksi yang **read-only & gak ninggalin jejak** boleh langsung dilakuin tanpa nawarin dulu:

- Baca file (`Read`, `cat`, buka & liat isi file)
- Cari/grep isi file atau struktur folder
- `git status`, `git diff`, `git log` (liat-liat doang, gak ubah apapun)

## Kapan Harus Nanya/Nawarin Dulu

Aksi yang **ninggalin jejak, ubah state, atau butuh tool eksternal** wajib ditawarin dulu ke user sebelum dijalanin:

- Jalanin CLI/tool eksternal (contoh: `kicad-cli`, compiler, script build)
- Generate file baru (report, export, netlist, dll) — meskipun cuma buat "ngebantu analisis"
- Edit/tulis/hapus file apapun di repo
- `git add`, `git commit`, `git push`, atau operasi git lain yang ngubah state
- Install/uninstall dependency atau package

Kalau kepaksa harus eksekusi buat bisa jawab pertanyaan analisis (misal: perlu jalanin tool buat "baca" struktur file biner/proprietary), **tetep tawarin dulu** dan jelasin kenapa itu perlu, kecuali user udah eksplisit bilang "gas" / "langsung aja" / kasih izin di awal.

## Konteks Project

Project **Smart Doorlock Kos ISK** — sistem doorlock pintar berbasis ESP32-C3, dikontrol via ESP-NOW & Firebase, terdiri dari:

- **`Hardware/`** — desain elektronik (KiCad): schematic & PCB buat modul Doorlock (ESP32-C3 + DRV8833 motor driver + Mini560 buck converter) dan Gateway.
- **`Firmware/`** — kode firmware ESP32 (PlatformIO).
- **`Document/`** — dokumentasi project, termasuk [Git Dictionary](Document/Documentation/Git%20Dictionary.md) buat konvensi commit message.

## Catatan Tambahan

- File `.kicad_sch`/`.kicad_pro` itu format teks (s-expression), bisa dibaca langsung tanpa perlu buka KiCad — prioritasin baca teksnya dulu sebelum mikir perlu jalanin tool eksternal.
- Bahasa komunikasi ke user: santai, ringkas, langsung ke inti — hindari muter-muter atau jelasin hal yang gak ditanya.

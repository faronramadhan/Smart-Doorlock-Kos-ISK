# Git Dictionary

Panduan ringkas format & tata cara commit message untuk project ini.

> Referensi: [The Art of Writing Meaningful Git Commit Messages](https://medium.com/@iambonitheuri/the-art-of-writing-meaningful-git-commit-messages-a56887a4cb49)

## Struktur Commit Message

Commit message terdiri dari 3 bagian, dipisah baris kosong:

```
<type>(<scope>): <subject>

<body>

<footer>
```

| Bagian    | Wajib?   | Isi                                                              |
|-----------|----------|-------------------------------------------------------------------|
| `subject` | Wajib    | `type(scope): deskripsi singkat` — baris pertama                 |
| `body`    | Opsional | Penjelasan **apa** & **kenapa** perubahan dibuat                 |
| `footer`  | Opsional | Referensi issue/PR atau breaking change                          |

**Aturan tiap bagian:**

- `type` — kategori perubahan, lihat [Commit Type Dictionary](#kamus-tipe-commit).
- `scope` (opsional) — bagian project yang kena dampak, contoh: `(doorlock)`, `(gateway)`. Boleh dikosongkan kalau perubahan bersifat umum.
- `subject` — ditulis imperative mood ("Tambah", bukan "Menambahkan"/"Ditambahkan"), huruf awal kapital, tanpa titik di akhir, maks ~50 karakter.
- `body` — kode sudah menjelaskan **bagaimana**, jadi body fokus ke **apa** & **kenapa**. Wrap tiap baris ~72 karakter.
- `footer` — info tambahan di luar isi utama commit, biasanya buat nutup/nyambung issue (`Closes #12`) atau nandain perubahan yang bikin hal lain jadi gak kompatibel lagi (`BREAKING CHANGE: ...`).

**Cara input di VSCode:** buka panel **Source Control** (ikon di sidebar kiri) → isi kotak pesan di atas tombol **Commit**.
- Baris pertama yang diketik = `subject`.
- Tekan **Enter 2x** (baris kosong) sebelum lanjut nulis `body`/`footer` — VSCode otomatis pisahin jadi paragraf baru.
- Commit dengan klik tombol **Commit**, atau `Ctrl+Enter` selagi fokus di kotak pesan.

## Commit Type Dictionary

| Type       | Kapan dipakai                                                        |
|------------|-----------------------------------------------------------------------|
| `feat`     | Nambah fitur/fungsionalitas baru (termasuk file desain hardware baru, misal KiCad) |
| `fix`      | Perbaikan bug                                                        |
| `docs`     | Perubahan dokumentasi saja (README, `*.md`, komentar)                |
| `style`    | Perubahan format/gaya kode, tidak ngubah logic (indentasi, spasi)    |
| `refactor` | Ubah struktur/isi kode tanpa nambah fitur atau fix bug                |
| `perf`     | Perubahan yang ningkatin performa                                    |
| `test`     | Nambah/ubah test, tidak nyentuh kode produksi                        |
| `build`    | Perubahan build system, dependency, konfigurasi (`platformio.ini`)   |
| `ci`       | Perubahan konfigurasi CI/CD                                          |
| `chore`    | Perubahan lain-lain yang tidak masuk kategori di atas (housekeeping) |
| `revert`   | Membatalkan commit sebelumnya                                        |

## Scope Dictionary

`gateway`, `doorlock`, `firmware`, `hardware`, `docs`, `espnow`, `firebase`

## Contoh

**Baik:**
```
feat(doorlock): tambah deep sleep saat idle

Motor driver dimatikan (DRV_SLEEP LOW) ketika status Firebase "lock"
untuk hemat baterai. Wake dipicu oleh interrupt ESP-NOW.
```

```
fix(gateway): perbaiki pairing gagal saat channel ESP-NOW berubah
```

**Baik, pakai footer:**
```
fix(doorlock): perbaiki motor tidak berhenti saat unlock

Motor tetap nyala walau limit switch sudah kena karena delay debounce
kegedean. Turunin delay dari 50ms ke 10ms.

Closes #8
```

**Hindari:**
```
update code
fix bug
misc changes
asdasd
```

## Disiplin Commit

1. Satu commit = satu perubahan logis. Jangan gabung banyak hal yang gak nyambung.
2. Bahasa bebas Indonesia atau Inggris, campur juga gapapa.
3. Selalu cek `git status` & `git diff` sebelum commit, pastikan gak ada file yang kesasar ke-stage.
4. Jangan commit langsung ke branch `main` untuk perubahan besar, pakai branch terpisah.
5. Cek `git log --oneline` buat review histori sebelum push.

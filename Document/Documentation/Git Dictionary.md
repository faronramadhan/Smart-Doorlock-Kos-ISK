# Git Dictionary

Panduan ringkas cara pakai Git Bash & format commit message untuk project ini.

> Referensi: [The Art of Writing Meaningful Git Commit Messages](https://medium.com/@iambonitheuri/the-art-of-writing-meaningful-git-commit-messages-a56887a4cb49)

## Apa itu Git

Git adalah **version control system (VCS)** — alat buat ngerekam & ngelola histori perubahan kode dari waktu ke waktu. Fungsinya:

- **Menyimpan histori** — tiap perubahan (commit) tercatat lengkap: siapa, kapan, apa yang berubah, dan kenapa. Bisa balik ke versi lama kapan aja.
- **Kerja bareng tanpa tabrakan** — tiap orang bisa kerja di branch masing-masing, terus digabungin (merge) belakangan, tanpa saling timpa perubahan.
- **Eksperimen aman** — bikin branch baru buat coba fitur/perbaikan tanpa ganggu kode utama di `main`. Kalau gagal, tinggal dibuang.
- **Backup & sinkronisasi** — kerja lokal di komputer sendiri, lalu `push` ke remote (repo "cadangan" di server lain, misal GitHub) buat backup & disinkronin ke tim.

Git bukan GitHub. Git adalah alatnya (jalan lokal di komputer, gak butuh internet), GitHub adalah layanan hosting yang nyimpen repo Git di cloud + nambahin fitur kolaborasi (Pull Request, Issue, dll). Project ini pakai Git buat version control, GitHub jadi remote-nya.

## Git Bash

Git Bash adalah terminal buat jalanin perintah Git di Windows lewat command-line (ketik perintah), bukan klik-klik lewat GUI.

### Instalasi

1. Download installer di [git-scm.com/downloads](https://git-scm.com/downloads) (pilih Windows).
2. Install seperti biasa, opsi default aman dipakai — cukup next-next sampai selesai.
3. Setelah install, klik kanan di folder project (lewat File Explorer), lalu pilih **Git Bash Here**, atau cari "Git Bash" di Start Menu.

### Setup Awal (sekali aja per komputer)

```bash
git config --global user.name "Nama Kamu"
git config --global user.email "email@kamu.com"
```

Data ini yang bakal muncul sebagai author di setiap commit. (Gak ada alternatif di panel Source Control — ini cuma bisa lewat terminal.)

### Navigasi Dasar

| Perintah        | Fungsi                                      |
|------------------|----------------------------------------------|
| `pwd`            | Nampilin folder aktif saat ini                |
| `ls`             | List isi folder                               |
| `ls -la`         | List isi folder termasuk file/folder tersembunyi |
| `cd <folder>`    | Pindah ke folder tertentu                     |
| `cd ..`          | Naik satu folder ke atas                      |
| `clear`          | Bersihin layar terminal                       |

### Perintah Git yang Sering Dipakai

Kolom terakhir = cara yang sama tapi lewat panel **Source Control** (ikon di sidebar kiri VSCode), buat yang gak mau ketik perintah.

| Perintah                          | Fungsi                                                        | Alternatif Source Control (kiri) |
|------------------------------------|-----------------------------------------------------------------|------------------------------------|
| `git status`                       | Cek file mana yang berubah/belum di-stage                      | Otomatis kelihatan di list "Changes" |
| `git diff`                         | Lihat detail perubahan baris demi baris                        | Klik nama filenya, diff kebuka otomatis |
| `git add <file>`                   | Stage file tertentu buat di-commit                              | Hover file, lalu klik ikon `+` |
| `git add .`                        | Stage semua perubahan di folder saat ini                        | Klik ikon `+` di sebelah "Changes" |
| `git commit -m "pesan"`            | Commit dengan pesan singkat (1 baris)                           | Ketik pesan di kotak atas, lalu klik **Commit** |
| `git commit`                       | Commit sambil buka editor buat nulis pesan multi-baris (body/footer) | Ketik multi-baris di kotak pesan yang sama |
| `git log --oneline`                | Lihat histori commit secara ringkas                             | Buka tab **Graph** / Timeline |
| `git branch`                       | Lihat daftar branch, tanda `*` = branch aktif                   | Lihat nama branch di status bar bawah kiri |
| `git branch <nama>`                | Bikin branch baru                                                | Klik nama branch di status bar, lalu pilih **Create new branch** |
| `git switch <branch>`              | Pindah ke branch lain                                            | Klik nama branch di status bar, lalu pilih branch |
| `git switch -c <branch>`           | Bikin branch baru sekaligus pindah ke sana                       | Sama kayak `git branch <nama>` di atas |
| `git pull`                         | Ambil & gabungin perubahan terbaru dari remote                  | Klik ikon sync di status bar, atau tombol **...**, lalu **Pull** |
| `git push`                         | Kirim commit lokal ke remote                                     | Klik ikon sync di status bar, atau tombol **...**, lalu **Push** |
| `git clone <url>`                  | Copy repository dari remote ke lokal                             | `Ctrl+Shift+P`, lalu ketik **Git: Clone** |
| `git merge <branch>`               | Gabungin branch lain ke branch aktif                             | Tombol **...**, lalu **Branch**, lalu **Merge Branch** |

### Nulis Commit Message Multi-baris di Git Bash

Untuk commit yang punya `body`/`footer` (bukan cuma `subject`), pakai flag `-m` berkali-kali — tiap `-m` otomatis jadi paragraf baru:

```bash
git commit -m "feat(doorlock): tambah deep sleep saat idle" -m "Motor driver dimatikan (DRV_SLEEP LOW) ketika status Firebase \"lock\" untuk hemat baterai. Wake dipicu oleh interrupt ESP-NOW."
```

Atau lebih nyaman, jalanin `git commit` tanpa `-m` — nanti kebuka text editor (biasanya Vim atau Nano), baris pertama diisi `subject`, kasih baris kosong, lanjut `body`/`footer`, simpan & tutup editor buat commit.

### Alur Kerja Contoh

```bash
git status                          # cek perubahan apa aja
git add .                           # stage semua perubahan
git commit -m "fix(gateway): perbaiki pairing gagal saat channel ESP-NOW berubah"
git push                            # kirim ke remote
```

Versi Source Control: stage file (`+`), ketik pesan commit, klik **Commit**, lalu klik ikon sync buat push.

Detail aturan penulisan pesan commitnya sendiri (`type`, `scope`, `subject`, dst) ada di bagian [Git Commit Message](#git-commit-message) di bawah.

## GitHub

Bagian Git Bash di atas udah bahas Git secara umum. Ini spesifik cara pakai GitHub sebagai remote project ini.

### Hubungin Repo Lokal ke GitHub

Kalau repo GitHub-nya udah ada dan tinggal di-copy ke lokal, cukup `git clone <url>` (sudah dibahas di atas). Tapi kalau folder project sudah ada duluan di lokal dan repo GitHub-nya baru dibikin, hubungin manual:

```bash
git remote add origin <url-repo-github>
git push -u origin main
```

- `git remote add origin <url>` — daftarin GitHub sebagai remote, dikasih nama `origin` (nama default, bebas diganti tapi biasanya dibiarin).
- Flag `-u` — dipakai sekali di awal, biar `git push`/`git pull` berikutnya gak perlu nyebut `origin main` lagi, cukup `git push` aja.

### Autentikasi

GitHub udah gak nerima login pakai password akun biasa. Pilih salah satu, tergantung format URL remote yang dipakai (cek pakai `git remote -v`).

#### HTTPS + Personal Access Token (PAT)

Paling gampang buat pemula. URL remote-nya format `https://github.com/...`.

1. Buka GitHub, **Settings**, lalu **Developer settings**, lalu **Personal access tokens**, lalu **Tokens (classic)**.
2. Klik **Generate new token**, kasih nama, centang scope minimal `repo`, atur masa berlaku, lalu **Generate token**.
3. Copy token yang muncul — cuma ditampilin sekali, langsung simpan di tempat aman.
4. Pas `git push`/`git pull` diminta username & password: isi username GitHub kamu di kolom username, dan **paste token tadi di kolom password** (bukan password akun).
5. Biar gak diminta terus tiap push, aktifin credential helper sekali: `git config --global credential.helper manager` (di Windows biasanya udah otomatis nyala lewat Git Credential Manager pas install Git).

#### SSH Key

Setup awal lebih ribet tapi gak perlu masukin token/password lagi tiap push. URL remote-nya format `git@github.com:...`.

1. Generate key: `ssh-keygen -t ed25519 -C "email@kamu.com"` (Enter aja terus kalau gak mau pakai passphrase).
2. Copy isi public key-nya: `cat ~/.ssh/id_ed25519.pub`.
3. Buka GitHub, **Settings**, lalu **SSH and GPG keys**, lalu **New SSH key**, paste isi public key tadi, lalu **Add SSH key**.
4. Tes koneksi: `ssh -T git@github.com` — kalau sukses muncul pesan "Hi `<username>`! You've successfully authenticated".
5. Pastikan URL remote-nya format SSH: `git remote set-url origin git@github.com:user/repo.git`.

### Push Branch & Bikin Pull Request

Alur standar project ini: kerja di branch terpisah, push branch itu ke GitHub, baru buka Pull Request (PR) buat direview sebelum digabung ke `main`.

```bash
git switch -c fitur/nama-fitur
# ...kerja & commit seperti biasa...
git push -u origin fitur/nama-fitur
```

Setelah push, buka repo di GitHub, biasanya muncul banner **Compare & pull request**, klik itu, isi judul/deskripsi PR, lalu **Create pull request**. Setelah direview dan disetujui, klik **Merge pull request**.

## Git Commit Message

### Struktur Commit Message

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

**Cara input di VSCode:** buka panel **Source Control** (ikon di sidebar kiri), lalu isi kotak pesan di atas tombol **Commit**.
- Baris pertama yang diketik = `subject`.
- Tekan **Enter 2x** (baris kosong) sebelum lanjut nulis `body`/`footer` — VSCode otomatis pisahin jadi paragraf baru.
- Commit dengan klik tombol **Commit**, atau `Ctrl+Enter` selagi fokus di kotak pesan.

### Commit Type Dictionary

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

### Scope Dictionary

`gateway`, `doorlock`, `firmware`, `hardware`, `docs`, `espnow`, `firebase`

### Contoh

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

### Disiplin Commit

1. Satu commit = satu perubahan logis. Jangan gabung banyak hal yang gak nyambung.
2. Bahasa bebas Indonesia atau Inggris, campur juga gapapa.
3. Selalu cek `git status` & `git diff` sebelum commit, pastikan gak ada file yang kesasar ke-stage.
4. Jangan commit langsung ke branch `main` untuk perubahan besar, pakai branch terpisah.
5. Cek `git log --oneline` buat review histori sebelum push.

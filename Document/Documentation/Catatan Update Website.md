# Catatan Update Website — 7 September 2026

Ringkasan hasil kerja sesi malam ini di folder [`Website/`](../../Website/): perbaikan bug, tambah fitur, dan bikin tampilan responsif. Dicatat di sini biar gampang di-review ulang atau dilanjutin ke branch lain.

## 1. Fix Bug: Dashboard Tidak Muncul Setelah Login

**Masalah:** Login berhasil di Firebase, tapi halaman dashboard gak pernah muncul.

**Penyebab:** Ada karakter nyasar di [`main.js`](../../Website/main.js) baris 14:
```js
const db = firebase.database();n
```
Huruf `n` di akhir baris bikin browser nganggep itu variabel yang gak terdefinisi → seluruh script berhenti jalan (uncaught error) begitu dimuat. Akibatnya semua kode setelahnya, termasuk `auth.onAuthStateChanged` yang tugasnya nampilin dashboard, gak pernah kepanggil.

**Fix:** Hapus karakter `n` yang nyasar itu.

## 2. Tambah Logo ISK

Logo (`Website/Logo ISK.jpg`) dipasang di:
- Kartu login/daftar
- Navbar dashboard
- Favicon tab browser

CSS `.brand-mark` diubah dari kotak background solid + ikon SVG jadi `<img>` dengan `object-fit: cover` biar logo pas di kotak rounded 32×32px.

## 3. Perpanjang Riwayat Akses per Kamar

Konstanta `MAX_HISTORY_PER_ROOM` di [`main.js`](../../Website/main.js) sebelumnya cuma **10** (komentarnya udah nulis 1000 tapi kodenya belum diubah). Sekarang jadi **1000** riwayat akses (unlock/lock/RFID) yang disimpan per kamar sebelum entri paling lama otomatis kehapus (trim logic di `logHistory()`).

## 4. Verifikasi Email Saat Daftar Akun

Sekarang alur daftar akun gak langsung masuk ke dashboard. Pakai fitur bawaan **Firebase Authentication** (link verifikasi via email, gratis, gak butuh backend tambahan):

1. User isi form **Daftar** → akun dibuat, Firebase otomatis kirim email berisi link verifikasi.
2. User diarahin ke halaman baru **"Verifikasi Email Anda"** (view baru: `#verifyView`) — belum bisa akses dashboard.
3. User buka email, klik link, balik ke website, klik tombol **"Saya Sudah Verifikasi"** → sistem cek ulang status ke Firebase (`user.reload()`), baru lanjut ke dashboard kalau memang sudah `emailVerified`.
4. Ada tombol **"Kirim Ulang Email"** kalau email hilang/gak masuk, dan tombol **Keluar**.
5. User yang login tapi belum verifikasi juga tetap diarahin ke halaman verifikasi ini, gak langsung ke dashboard.

**File yang berubah:** [`index.html`](../../Website/index.html) (tambah section `#verifyView`), [`main.js`](../../Website/main.js) (logic `onAuthStateChanged`, `sendEmailVerification`, handler tombol verifikasi).

> Catatan: gak perlu setup tambahan di Firebase Console selain Email/Password sign-in yang emang udah aktif dari awal.

## 5. Tampilan Responsif (Mobile & Desktop)

Layout dasarnya sebenarnya udah lumayan responsif (grid kamar, modal bottom-sheet di HP), tapi disempurnain lagi di [`style.css`](../../Website/style.css):

| Perubahan | Breakpoint |
|---|---|
| Grid kamar jadi 4 kolom + lebar konten maksimum diperbesar | `min-width: 1300px` (layar desktop lebar) |
| Padding & elemen dirapatkan (navbar, toolbar, tombol aksi kamar jadi 2 kolom) | `max-width: 480px` (HP kecil) |
| Teks "Online" di status pill disembunyikan, sisain titik status doang | `max-width: 480px` |

Teks "Online" di navbar dibungkus `<span class="status-text">` di [`index.html`](../../Website/index.html) biar bisa ditarget CSS buat disembunyiin di layar sempit.

**Sudah dites** pakai headless browser (Playwright) di ukuran 375×812 (mobile) dan 1440–1600px (desktop): kartu login center simetris, grid kamar & navbar menyesuaikan, gak ada error JavaScript saat render.

## File yang Berubah Malam Ini

- `Website/index.html`
- `Website/main.js`
- `Website/style.css`
- `Website/Logo ISK.jpg` (baru)

## Belum Dikerjakan / Bisa Lanjut Nanti

- Nama file `Logo ISK.jpg` masih pakai spasi — aman dipakai, tapi lebih rapi kalau diganti `logo-isk.jpg`.
- Kode masih di branch `website` — cek lagi apakah perlu dipisah ke branch fitur sebelum di-push, biar gak bentrok sama kerjaan rekan tim.

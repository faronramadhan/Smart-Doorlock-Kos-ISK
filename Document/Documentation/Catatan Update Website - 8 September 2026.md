# Catatan Update Website — 8 September 2026

Ringkasan hasil kerja hari ini di folder [`Website/`](../../Website/): fitur persetujuan admin untuk pendaftar baru, penamaan otomatis di Firebase, perbaikan bug alamat kos, dan deploy ke Firebase Hosting. Dicatat di sini biar gampang di-review ulang atau dilanjutin ke branch lain.

## 1. Fitur: Pendaftaran Harus Disetujui Admin

Sebelumnya, siapa pun yang daftar dan verifikasi email langsung dapat akses penuh ke dashboard (bisa buka/kunci semua pintu). Sekarang ada lapisan persetujuan:

1. Setiap pendaftaran baru otomatis tersimpan di `users/{uid}` dengan `status: "pending"`.
2. Setelah verifikasi email, akun **tidak langsung masuk dashboard** — muncul halaman baru "Menunggu Persetujuan Admin" (`#pendingView`).
3. Admin (akun dengan `role: "admin"`) melihat panel baru **"Persetujuan Pendaftar"** di atas dashboard, isinya daftar pendaftar `pending` dengan tombol **Setujui** / **Tolak**.
4. Begitu disetujui/ditolak, halaman pendaftar otomatis berpindah (realtime, tanpa refresh) — kalau ditolak, muncul pesan "Pendaftaran Ditolak".
5. Login sekarang bisa pakai **username biasa**, bukan cuma email — kalau input tidak mengandung "@", sistem otomatis melengkapi jadi email internal `...@isk-house.local` untuk Firebase Auth.

**Akun admin pertama:** `AdminISK-House` (di-bootstrap manual lewat Firebase Console, karena tidak ada backend untuk melakukan ini otomatis — lihat bagian Security Rules di bawah).

**File yang berubah:** [`index.html`](../../Website/index.html) (tambah `#pendingView`, panel `#approvalBlock`), [`main.js`](../../Website/main.js) (`handleUserRecord`, `showAppView`, `showPendingView`, `renderApprovalPanel`, `toAuthEmail`), [`style.css`](../../Website/style.css) (`.pending-user-item`, dll).

## 2. Firebase Realtime Database — Security Rules

Sebelumnya tidak ada file rules di repo (dikelola manual lewat Firebase Console). Supaya persetujuan admin di atas benar-benar mengunci akses di level database (bukan cuma tampilan), rules baru dipasang manual di **Firebase Console → Realtime Database → Rules**:

- `users/$uid` — hanya bisa dibuat oleh pemiliknya sendiri dengan `status: "pending"` (tidak bisa self-approve/self-admin); mengubah `role`/`status` orang lain hanya boleh oleh akun `role: "admin"`.
- `locations` — hanya bisa dibaca/ditulis oleh akun `role: "admin"` atau `status: "approved"`.
- `meta/userCounter` — boleh dibaca/ditulis siapa saja yang sudah login (dipakai untuk penomoran label user, lihat poin 4).

> Rules ini **tidak tersimpan di file/repo** (Realtime Database rules dikelola dari Firebase Console, bukan lewat kode), jadi kalau butuh diubah lagi harus lewat Console langsung.

## 3. Penamaan Otomatis di Firebase (Bukan Lagi Kode Acak)

Sebelumnya, key Firebase untuk lokasi baru dan gateway/lantai baru dibuat pakai `push()` (hasilnya string acak seperti `-P0wYezCwYrVv3bfjF3h`). Sekarang:

- **Lokasi/Kos** — key otomatis jadi gabungan Nama + Alamat yang diketik, mis. Nama "ISK House" + Alamat "Kemayoran" → key `ISK House - Kemayoran`. Kalau ada nama yang sama persis, otomatis ditambah `(2)`, `(3)`, dst. (`generateLocationKey()` di `main.js`).
- **Gateway/Lantai** — key otomatis jadi `Gateway 1`, `Gateway 2`, dst berurutan per lokasi, terlepas dari nama lantai yang diketik user (mis. "Lantai 1" tetap tersimpan di field `name`, tapi key-nya `Gateway 1`) (`generateGatewayKey()`).

**Catatan:** ini cuma berlaku untuk data **baru**. Lokasi/gateway lama yang key-nya masih acak (`loc1`, `gw1`, atau string random) tidak berubah otomatis — kalau mau rapi, harus dihapus lalu ditambahkan ulang.

## 4. Label User yang Mudah Dibaca (User-1, User-2, Admin)

Key di `users/{uid}` **tidak bisa** diganti jadi teks seperti "Admin"/"User-1" — itu harus tetap UID asli dari Firebase Authentication, karena seluruh sistem login & security rules mencocokkan berdasarkan UID itu (dijelaskan ke user, tidak diubah).

Sebagai gantinya, ditambah field baru `label` di dalam data user:
- Pendaftar baru otomatis dapat label **"User-1"**, **"User-2"**, dst secara berurutan (pakai Firebase transaction di `meta/userCounter` biar aman dari race condition).
- Label ini yang ditampilkan di panel "Persetujuan Pendaftar" (bareng email) dan di kolom **"Oleh"** pada tabel Riwayat Akses — jadi tidak lagi tampil email panjang di riwayat.
- Untuk 2 akun yang sudah ada sebelum fitur ini (AdminISK-House, akun pribadi user), field `label` ditambahkan manual lewat Firebase Console (`Admin` dan `User-1`), dan `meta/userCounter` di-set ke `1` biar penomoran lanjut ke `User-2`.

## 5. Bug Fix: Alamat Kos Tidak Berubah Saat Ganti Cabang

**Masalah:** waktu ganti pilihan cabang kos di dropdown, teks alamat di bawahnya tetap nampilin alamat cabang sebelumnya (stale).

**Penyebab:** handler `locationSelect` (`change` event) di [`main.js`](../../Website/main.js) cuma manggil `renderGatewayTabs()` dan `renderAll()`, lupa update `locationAddress.textContent`.

**Fix:** tambah `locationAddress.textContent = locationsData[currentLoc]?.address || '';` langsung di handler tersebut.

## 6. Deploy ke Firebase Hosting

Website sekarang bisa diakses dari HP (atau device apa pun) lewat internet, tidak perlu satu WiFi dengan laptop:

**URL: https://isk-house.web.app**

Setup: file [`firebase.json`](../../firebase.json) (baru) mengarahkan hosting ke folder `Website/` sambil mengecualikan `Website/Firmware/**` (project firmware terpisah yang kebetulan ada di dalam folder yang sama), dan [`.firebaserc`](../../.firebaserc) (baru) menunjuk ke project `isk-house`.

**Cara update situs live kalau ada perubahan kode nanti:**
```
npx firebase-tools deploy --only hosting
```
Perubahan di lokal (127.0.0.1:5500) **tidak otomatis** tersinkron ke isk-house.web.app — harus dijalankan manual tiap kali ada perubahan yang mau di-publish.

## File yang Berubah/Baru Hari Ini

- `Website/index.html`
- `Website/main.js`
- `Website/style.css`
- `firebase.json` (baru)
- `.firebaserc` (baru)

## Belum Dikerjakan / Bisa Lanjut Nanti

- Lokasi & gateway lama (`loc1`, `loc2`, `gw1`, dan 2 kos dengan key acak) belum dirapikan ke skema penamaan baru — perlu dihapus & ditambah ulang manual kalau mau konsisten.
- Belum ada fitur untuk mencabut akses (revoke) akun yang sudah `approved` — saat ini kalau sudah disetujui, aksesnya permanen kecuali diubah manual lewat Firebase Console.
- Belum ada cara menambah admin baru selain lewat edit manual field `role` di Firebase Console.

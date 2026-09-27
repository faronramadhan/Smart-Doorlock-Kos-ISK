# Catatan Update Website — 13 September 2026

Ringkasan hasil kerja hari ini di folder [`Website/`](../../Website/): perbaikan 2 bug di alur pendaftaran/persetujuan admin, Realtime Database Rules yang sekarang tersimpan sebagai file di repo, deploy ulang ke Firebase Hosting, dan dokumentasi arsitektur website. Dicatat di sini biar gampang di-review ulang atau dilanjutin ke branch lain.

## 1. Bug Fix: "Email Sudah Digunakan" Setelah Hapus Akun Test

**Masalah:** Akun test dihapus dari Firebase, tapi waktu daftar ulang pakai email yang sama, muncul error "email sudah digunakan".

**Penyebab:** Menghapus data di **Realtime Database** (`users/{uid}`) itu **beda** dengan menghapus akun di **Firebase Authentication**. Kalau cuma dihapus dari Database, akun Auth-nya (email + password) masih ada, jadi Firebase Auth tetap menolak pendaftaran ulang dengan email itu — bukan bug di kode, tapi akun test-nya belum benar-benar hilang. Solusinya: hapus dari **kedua tempat** (Authentication → Users, dan Realtime Database).

**Perbaikan kode:** Pesan error `auth/email-already-in-use` di [`main.js`](../../Website/main.js) (`terjemahkanErrorFirebase()`) diperjelas supaya langsung menjelaskan penyebab ini ke siapa pun yang mengalaminya, tanpa perlu nebak-nebak lagi.

## 2. Bug Fix: Pendaftar Baru Tidak Muncul di Panel Persetujuan Admin

**Masalah:** Daftar akun baru dengan email lain berhasil, tapi pendaftarnya tidak muncul di panel "Persetujuan Pendaftar" admin.

**Penyebab:** Panel admin melakukan query `users.orderByChild('status').equalTo('pending')` (`renderApprovalPanel()` di `main.js`). Realtime Database mewajibkan izin baca **di level node yang di-query** (`/users` itu sendiri), bukan cuma di level `/users/{uid}` per akun. Rules yang dipasang tanggal 8 September kemarin cuma mengizinkan baca per-`$uid`, jadi query ini ditolak diam-diam — tidak ada error yang kelihatan di UI, panel cuma keliatan kosong.

**Perbaikan:**
- Rules Realtime Database diperbarui: koleksi `users` sekarang punya `.read` khusus admin di level node-nya (lihat poin 3), plus `.indexOn: "status"` biar query lebih efisien.
- Ditambah error callback di dua listener realtime (`attachUserRecordListener()` dan `renderApprovalPanel()` di `main.js`) — kalau ke depannya ada masalah izin lagi, sekarang langsung kelihatan pesannya (di console & UI panel), tidak lagi gagal diam-diam.

## 3. Realtime Database Rules Sekarang Tersimpan sebagai File (Bukan Cuma di Console)

Catatan 8 September lalu bilang rules "tidak tersimpan di file/repo, dikelola manual lewat Firebase Console". Sekarang itu berubah — dibuat [`database.rules.json`](../../database.rules.json) baru di root repo, isinya:

- `users` (koleksi) — hanya bisa dibaca admin (fix untuk bug poin 2 di atas), dengan `.indexOn: "status"`.
- `users/$uid` — dibaca cuma oleh pemiliknya sendiri; ditulis oleh pemiliknya sendiri atau admin.
- `locations` — dibaca/ditulis oleh admin atau akun berstatus `approved`.
- `meta` — dibaca/ditulis siapa saja yang sudah login (dipakai untuk penomoran `User-1`, `User-2`, dst).

[`firebase.json`](../../firebase.json) juga diupdate, tambah konfigurasi `"database": { "rules": "database.rules.json" }` supaya rules ini bisa di-deploy lewat `firebase deploy --only database`, tidak perlu lagi copy-paste manual ke Console tiap kali berubah. Rules-nya sudah diterapkan (user paste manual ke Console hari ini).

## 4. Deploy Ulang ke Firebase Hosting

Semua perubahan `main.js` di atas sudah live:

**URL: https://isk-house.web.app**

```
npx firebase-tools deploy --only hosting --project isk-house
```

(Firebase CLI belum terpasang global di komputer ini, jadi dijalankan lewat `npx` yang otomatis download sekali pakai. Login CLI ternyata masih tersimpan dari sesi sebelumnya jadi tidak perlu login ulang.)

## 5. Dokumentasi Arsitektur & Fitur Website

Dibuatkan dokumentasi rinci (diagram arsitektur Browser↔Firebase, diagram alur autentikasi & persetujuan, struktur data Realtime Database, daftar lengkap fitur per blok, dan tabel security rules) untuk memudahkan siapa pun yang belum familiar dengan codebase ini. Belum dimasukkan ke repo sebagai file — kalau mau disimpan permanen di `Document/`, tinggal bilang.

## File yang Berubah/Baru Hari Ini

- `Website/main.js`
- `firebase.json`
- `database.rules.json` (baru)
- `Document/Documentation/Catatan Update Website - 13 September 2026.md` (baru, dokumen ini)

## Belum Dikerjakan / Bisa Lanjut Nanti

- Firmware ESP32 (`Website/Firmware/src/main.cpp`) masih kode template kosong — belum ada logic doorlock/RFID sama sekali, jadi tombol Buka/Kunci di dashboard baru mengubah data, belum menggerakkan perangkat fisik.
- Teks tombol "Maksimal 15 kamar tercapai" di `renderRooms()` (`main.js`) tidak sinkron dengan batas sebenarnya `MAX_ROOMS = 20` — kosmetik, belum diperbaiki.
- Indikator "Online" di navbar masih statis, belum disambungkan ke status koneksi Firebase (`.info/connected`).

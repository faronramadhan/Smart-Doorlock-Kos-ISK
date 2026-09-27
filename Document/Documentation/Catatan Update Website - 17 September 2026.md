# Catatan Update Website — 17 September 2026

Ringkasan hasil kerja hari ini di folder [`Website/`](../../Website/): fitur klasifikasi Doorlock & Gateway untuk admin, perombakan struktur Realtime Database (beberapa iterasi sampai ke bentuk final yang ringkas), penomoran kamar otomatis mengikuti lantai, serta beberapa bug fix. Semua sudah di-commit ke branch `website` dan di-deploy ke `isk-house.web.app`. Dicatat di sini biar gampang di-review ulang atau dilanjutin ke sesi lain.

## 1. Fitur Baru: Klasifikasi Doorlock & Gateway (Admin)

Alur pairing fisik (Doorlock ↔ Gateway lewat ESP-NOW, lihat [HMAC.md](HMAC.md)) belum terhubung ke website (bagian firmware Gateway↔Firebase sengaja ditunda dulu). Tapi sisi website-nya sudah disiapkan duluan:

- **Node `pendingDevices/{macDoorlock}`** — nantinya diisi Gateway begitu sebuah Doorlock selesai pairing HMAC. Muncul di panel admin "Doorlock Menunggu Klasifikasi", admin pilih Cabang → Lantai → Gateway → Nomor Kamar (masing-masing bisa pilih yang sudah ada atau bikin baru langsung dari form yang sama), lalu tersimpan sebagai kamar baru dengan field `doorlockMac`.
- **Node `pendingGateways/{macGateway}`** — nantinya diisi Gateway sendiri begitu ia pertama kali terhubung ke Firebase (sebelum ada nama/lokasi, sebelum ada Doorlock manapun yang dipairing ke situ). Muncul di panel admin "Gateway Menunggu Klasifikasi", admin pilih Cabang → Lantai → ketik Nama Gateway, tersimpan dengan field `gatewayMac`.

Kedua panel & modal ini pola-nya sama seperti panel "Persetujuan Pendaftar" yang sudah ada sebelumnya — realtime listener + render list + tombol aksi.

## 2. Restrukturisasi Realtime Database

Awalnya 1 lantai = 1 "gateway" secara konsep (rancu), padahal di lapangan jangkauan radio 1 gateway ESP-NOW cuma ~5 meter — satu lantai fisik sering butuh lebih dari 1 gateway. Struktur dirombak total, melalui beberapa iterasi hari ini sampai ke bentuk final:

**Skema final:**
```
locations
  {cabang}                    <- key = nama+alamat (mis. "ISK House Kemanggisan - Jl. ...")
    name, address
    {lantai}                  <- key = nama yang diketik admin langsung (mis. "Lantai 2")
      {gateway}                <- key = nama yang diketik admin langsung (mis. "Gateway 001")
        gatewayMac (opsional, kalau dibuat lewat alur klasifikasi gateway)
        Kamar {n}: { tenant, rfidAccess, status, unlockedAt, doorlockMac, history }
```

Tidak ada lagi node perantara seperti `floors`, `gateways`, atau `rooms` — setiap level langsung berisi child-nya, dan key-nya langsung nama yang bisa dibaca (bukan id generik seperti `loc1`/`gw1`).

**Migrasi otomatis** — supaya data yang sudah ada di produksi tidak hilang, `Website/main.js` (`initAppData()`) menjalankan 3 tahap pembersihan berurutan begitu dashboard admin dibuka, sebelum data dirender:
1. `migrateOldSchemaIfNeeded()` — konversi skema lama (`gateways` langsung di lokasi, atau wrapper `floors/gateways`) ke skema final.
2. `stripLegacyCreatedAt()` — hapus field `createdAt` yang sempat dipakai sebagai "penjaga" node kosong (lihat poin 3), kalau masih ada sisa dari deploy sebelumnya.
3. `flattenLegacyRoomsIfNeeded()` — ratakan wrapper `rooms` lama jadi `Kamar {n}` langsung.

Kalau ada yang perlu dimigrasikan, listener `return` dulu dan nunggu tulisan ke Firebase selesai — snapshot berikutnya otomatis sudah bersih, baru lanjut render.

## 3. Konsekuensi Desain: Node Kosong Tidak Tersimpan

Firebase Realtime Database tidak bisa menyimpan node yang isinya benar-benar kosong (`{}`) — otomatis dipangkas. Sempat dicoba pakai field `createdAt` sebagai "penjaga" supaya lantai/gateway yang baru dibuat (belum ada isi) tetap tersimpan, tapi ini dianggap mengganggu kalau dilihat di Firebase Console, jadi **dihapus lagi** atas permintaan eksplisit.

Konsekuensinya: lantai atau gateway yang baru dibuat lewat tombol "+ Lantai"/"+ Gateway" di dashboard **tidak tersimpan permanen** kalau ditinggal kosong (belum ada gateway/kamar sungguhan di dalamnya) — hilang lagi setelah refresh. Ini sudah dikonfirmasi & diterima sebagai trade-off yang disengaja. Gateway yang dibuat lewat alur klasifikasi (poin 1) aman dari masalah ini karena selalu punya field `gatewayMac`.

## 4. Penomoran Kamar Mengikuti Lantai

`getRoomNumberRange()` di `main.js` menghasilkan rentang nomor kamar dari angka yang ada di nama lantai: **Lantai 2 → kamar 201-220**, **Lantai 3 → 301-320**, dst. Kalau nama lantai tidak mengandung angka (mis. "Lantai Dasar"), fallback ke penomoran polos 1-20. Berlaku di modal Tambah/Edit Kamar maupun modal klasifikasi Doorlock (termasuk saat lantai barunya belum tersimpan — dihitung real-time dari nama yang sedang diketik admin).

## 5. Bug Fix: Kamar Hantu dari Array Bercelah Firebase

Firebase Realtime Database merepresentasikan node dengan child bernomor rapat (mis. `1,3,5`) sebagai **array JSON bercelah** (`[null, kamar1, null, kamar3, null, kamar5]`), bukan object biasa — ditemukan langsung lewat `firebase database:get` CLI saat investigasi bug lain. Ini bisa bikin:
- Kamar "hantu" ikut ter-render (celah `null` di-spread jadi object nyaris kosong, bikin badge status rusak).
- Nomor kamar kosong salah dianggap "sudah terpakai" di dropdown Tambah Kamar.

Diperbaiki dengan memfilter entri `null` di `getRooms()` (helper terpusat, dipakai semua tempat yang baca daftar kamar).

## 6. Investigasi Langsung ke Database Produksi

Untuk mendiagnosis laporan "`createdAt` masih muncul", data produksi dicek langsung lewat `firebase database:get` (bukan tebak-tebakan) — ternyata itu data lama yang belum sempat dibersihkan karena tab browser admin masih menjalankan `main.js` versi lama dari sebelum deploy (Firebase Hosting tidak auto-refresh tab yang sudah terbuka). Field `createdAt` yang tersisa dan 1 node uji coba manual (`Kamar 101: ""`, format tidak valid) dihapus langsung dari produksi lewat `firebase database:remove -f`.

**Pelajaran:** kalau ada laporan bug "sudah di-fix tapi masih muncul", cek dulu apakah tab browser sudah benar-benar di-reload (bukan cuma refresh) — SPA + Firebase Hosting tidak mendorong update ke tab yang sedang berjalan.

## 7. Deploy

Semua perubahan sudah live:

**URL: https://isk-house.web.app**

Dijalankan berkali-kali sepanjang hari lewat:
```
npx firebase-tools deploy --only database,hosting --project isk-house
```
(Perlu `NODE_OPTIONS="--max-old-space-size=2048"` — tanpa itu `firebase deploy --only database` sempat gagal dengan *fatal process out of memory* saat cek syntax rules, di komputer ini.)

Rules Realtime Database juga diperbarui ([`database.rules.json`](../../database.rules.json)): tambah node `pendingDevices` dan `pendingGateways`, keduanya read/write khusus admin.

## File yang Berubah/Baru Hari Ini

- `Website/index.html`
- `Website/main.js`
- `Website/style.css`
- `database.rules.json`
- `Document/Documentation/Catatan Update Website - 17 September 2026.md` (baru, dokumen ini)

## Commit Hari Ini (branch `website`, sudah di-push)

1. `feat(website): klasifikasi doorlock & struktur lantai > gateway`
2. `refactor(website): ringkas struktur DB - hapus wrapper floors/gateways`
3. `refactor(website): hapus field createdAt di lantai/gateway`
4. `feat(website): klasifikasi gateway baru & nomor kamar ikut lantai`
5. `refactor(website): hapus wrapper "rooms" - kamar langsung child gateway`

## Belum Dikerjakan / Bisa Lanjut Nanti

- **Komunikasi Gateway ↔ Firebase** (firmware ESP32) — Gateway belum benar-benar menulis ke `pendingDevices`/`pendingGateways`, dan belum membaca perintah Buka/Kunci atau status `rfidAccess` dari Firebase. Sempat mulai dikerjakan lalu ditunda atas permintaan, sebelum akhirnya fokus hari ini pindah ke sisi struktur data & UI klasifikasi.
- Tombol Buka/Kunci di dashboard baru mengubah status di database (simulasi 5 detik lalu auto-kunci) — belum menggerakkan Doorlock fisik.
- Belum ada tombol hapus/edit nama untuk lantai atau gateway (cuma bisa tambah); mengganti nama berarti bikin key baru.
- Indikator "Online" di navbar masih statis, belum disambungkan ke status koneksi Firebase (`.info/connected`).

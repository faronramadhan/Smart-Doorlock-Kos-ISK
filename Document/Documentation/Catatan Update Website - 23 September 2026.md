# Catatan Update Website — 23 September 2026

Ringkasan hasil kerja hari ini di folder [`Website/`](../../Website/): perbaikan alur tambah kos/lantai/gateway yang gagal diam-diam, pembalikan keputusan "node kosong tidak disimpan" (17 September) setelah dikonfirmasi ulang, fitur hapus lantai/gateway, dropdown lantai custom, dan investigasi langsung ke deploy pipeline karena situs live sempat tertinggal dari kode lokal. Semua sudah di-commit ke branch `website` dan di-deploy ke `isk-house.web.app`.

## 1. Bug: Tambah Kos/Lantai/Gateway/Kamar Gagal Diam-Diam

Semua modal tambah data (`locModalSave`, `floorModalSave`, `gwModalSave`, `modalSave` untuk kamar) memanggil `db.ref(...).set()` **tanpa `.catch()`**. Kalau penulisan ke Firebase gagal (mis. `PERMISSION_DENIED`), modal tetap tertutup seolah berhasil — tidak ada pesan error, tidak ada data tersimpan. Diperbaiki dengan menambah elemen pesan error (`.auth-error`) di tiap modal dan menutup modal hanya setelah `.then()` sukses, meniru pola yang sudah benar di modal "Klasifikasikan Gateway/Doorlock".

## 2. Pembalikan Keputusan: Lantai/Gateway Kosong Kini Tersimpan Permanen

Keputusan 17 September ("lantai/gateway kosong tidak disimpan permanen, hilang lagi setelah refresh") ternyata bikin fitur "+ Lantai"/"+ Gateway" terasa tidak berfungsi dari sudut pandang admin — mereka menambah lantai, tidak muncul apa-apa, tanpa error. Setelah dikonfirmasi ulang ke pemilik proyek, keputusan dibalik:

- Lantai/gateway baru sekarang **langsung ditulis ke Firebase** dengan field placeholder `createdAt` supaya node-nya tidak dipangkas (RTDB tidak bisa menyimpan node tanpa child sama sekali).
- `stripLegacyCreatedAt()` diubah jadi lebih hati-hati: `createdAt` cuma dihapus **kalau node itu sudah punya child lain juga** (gateway sungguhan untuk lantai, kamar/`gatewayMac` sungguhan untuk gateway). Kalau `createdAt` itu satu-satunya field, dibiarkan — menghapusnya akan membuat node ikut hilang (dipangkas Firebase), yang justru mengulang bug lama.
- `getGateways()`/`getRooms()` diperbarui untuk memfilter `createdAt` sebagai field metadata (`FLOOR_META_FIELDS`, ditambahkan ke `GATEWAY_META_FIELDS`), supaya tidak ikut ter-render sebagai gateway/kamar palsu.
- Sempat dicoba pendekatan "pending client-side saja" (lantai/gateway kosong cuma ada di memori browser, baru ditulis ke Firebase begitu kamar pertama ditambahkan) sebagai alternatif yang tidak perlu placeholder field — tapi ditolak karena admin ingin datanya langsung terlihat di Firebase Console walau masih kosong. Pendekatan ini di-revert total sebelum lanjut ke solusi `createdAt`.

## 3. Bug: Tab Lantai/Gateway Tidak Berubah Warna Saat Diklik

`renderFloorTabs()` dan `renderGatewayTabs()` mengganti `currentFloor`/`currentGw` di handler klik masing-masing, tapi **tidak pernah memanggil ulang fungsi render tab itu sendiri** — cuma render kamar & gateway di bawahnya. Akibatnya klik "Lantai 2" berhasil pindah konteks (bisa tambah kamar di lantai itu), tapi class `active` (warna biru) tetap menempel di tab lama. Diperbaiki dengan menambah pemanggilan `renderFloorTabs()`/`renderGatewayTabs()` di masing-masing handler klik tab.

## 4. Fitur Baru: Hapus Lantai & Hapus Gateway

Sebelumnya cuma bisa tambah, tidak bisa hapus lantai/gateway (dicatat sebagai item "belum dikerjakan" di catatan 17 September). Sekarang ada tombol "Hapus" di baris tab Lantai dan baris tab Gateway, menghapus node yang sedang dipilih (`currentFloor`/`currentGw`) beserta semua isi di bawahnya, dengan `confirm()` dulu — pola yang sama seperti tombol hapus kos yang sudah ada.

## 5. Dropdown Custom untuk Nama Lantai

Dua perubahan pada input nama lantai di modal "Tambah Lantai":
1. Dari input teks bebas jadi dropdown pilihan "Lantai 1".."Lantai 20" (mengecualikan yang sudah dipakai) — supaya penulisan seragam dan menjaga format yang dibutuhkan `getRoomNumberRange()` (mengambil angka dari nama lantai untuk menentukan rentang nomor kamar, mis. Lantai 2 → kamar 201-220).
2. `<select>` native diganti komponen dropdown custom (`.custom-select`, lihat `style.css`) karena `<select>` browser bisa membuka menunya ke **atas** kalau ruang di bawah dianggap sempit oleh browser — perilaku ini tidak bisa dikontrol lewat CSS. Dropdown custom selalu membuka ke bawah dengan tinggi maksimal + scroll.

## 6. Investigasi: Situs Live Tertinggal dari Kode Lokal

Setelah beberapa ronde laporan "sudah saya perbaiki tapi masih gagal, bahkan hard refresh", ditelusuri langsung lewat `firebase database:get` (CLI) — ternyata data yang ditulis situs live **cocok dengan versi kode SEBELUM sesi perbaikan ini** (node kosong `{}` yang langsung dipangkas), bukan versi terbaru. Penyebabnya: semua perbaikan sepanjang sesi ini hanya ada di working directory lokal, **belum pernah di-`firebase deploy`** — situs di `isk-house.web.app` masih menjalankan build lama, dan `Cache-Control: max-age=3600` di Firebase Hosting membuat browser tetap menyajikan `main.js` lama walau di-refresh biasa.

**Pelajaran:** kalau user melaporkan bug pada situs live padahal kode lokal sudah "seharusnya" benar, cek dulu **kapan terakhir di-deploy**, jangan asumsikan kode lokal = kode yang sedang dites. Verifikasi dengan `curl` membandingkan file live vs lokal lebih cepat & pasti daripada menebak dari gejala di browser.

Sejak titik ini, tiap kali ada perbaikan kode, langsung di-deploy via:
```
npx firebase-tools deploy --only hosting --project isk-house
```

## File yang Berubah/Baru Hari Ini

- `Website/index.html`
- `Website/main.js`
- `Website/style.css`
- `Document/Documentation/Catatan Update Website - 23 September 2026.md` (baru, dokumen ini)

## Commit Hari Ini (branch `website`)

1. `fix(website): lantai/gateway kosong tersimpan permanen, tab hapus & aktif diperbaiki`
2. `docs: catatan update website 23 September 2026`

## Deploy

**URL: https://isk-house.web.app** — di-deploy berkali-kali sepanjang sesi lewat `npx firebase-tools deploy --only hosting --project isk-house`, terakhir setelah commit hari ini.

## Belum Dikerjakan / Bisa Lanjut Nanti

- **Komunikasi Gateway ↔ Firebase** (firmware ESP32) — masih belum tersambung, sama seperti catatan 17 September.
- Tombol Buka/Kunci di dashboard masih simulasi (ubah status di database, auto-kunci 5 detik) — belum menggerakkan Doorlock fisik.
- Belum ada fitur **edit nama** lantai/gateway/kos (cuma tambah & hapus) — mengganti nama berarti bikin key baru lalu pindahkan data lama secara manual.
- Indikator "Online" di navbar masih statis, belum disambungkan ke status koneksi Firebase (`.info/connected`).
- Dropdown custom baru dibuat untuk nama lantai saja; nama gateway masih input teks bebas (belum diminta diseragamkan).

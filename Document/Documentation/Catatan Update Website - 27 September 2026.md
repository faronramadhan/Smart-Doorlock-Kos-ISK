# Catatan Update Website — 27 September 2026

Ringkasan hasil kerja hari ini: riwayat dipindah dari Firebase ke browser, dua perbaikan deploy, lalu yang paling besar, **firmware Gateway yang tersambung ke Firebase** ([`Website/Firmware/`](../../Website/Firmware/)) lengkap dengan simulasi status doorlock, tampilan status di dashboard, dan pendaftaran otomatis beberapa gateway sekaligus. Sesi terakhir: pendaftaran akun tanpa verifikasi email, admin bisa ngeluarin user, celah keamanan Rules ditutup, dan gateway cuma bisa ditambah lewat klasifikasi. Detail teknis per pengujian ada di [`Test/Website/`](../../Test/Website/) (branch `main`); nama variabel/field yang dipakai dibakukan di [Object Dictionary](Object%20Dictionary.md).

## 1. Riwayat Tidak Lagi Disimpan di Firebase

Riwayat (history) buka/kunci/RFID sebelumnya disimpan di `locations/.../Kamar {n}/history`, maksimal 1000 entri per kamar. Sekarang **cuma disimpan di `localStorage` browser** (key `isk-history`), atas permintaan pemilik proyek.

- `logHistory()` dan `renderHistory()` di [`main.js`](../../Website/main.js) baca/tulis ke `localStorage`, batas tetap 1000 entri per kamar.
- `moveFirebaseHistoryToLocal()` jalan otomatis waktu dashboard dibuka (pola sama kayak migrasi lain): node `history` lama disalin ke `localStorage` browser itu, lalu dihapus dari Firebase.
- **Konsekuensi:** riwayat cuma kelihatan di browser/perangkat yang nyatet, dan hilang kalau data situs dihapus.
- Bonus: node kamar jadi kecil, yang bikin Gateway bisa pakai *stream* realtime (lihat poin 4).

## 2. Fix: Browser Masih Jalanin `main.js` Lama Setelah Deploy

Setelah deploy, history **tetap** masuk ke Firebase. Penyebabnya Firebase Hosting ngasih `Cache-Control: max-age=3600`, jadi browser admin masih pakai `main.js` versi lama sampai 1 jam.

- [`firebase.json`](../../firebase.json): header `Cache-Control: no-cache` untuk `**/*.@(js|css|html)`.
- [`index.html`](../../Website/index.html): `main.js?v=20260927` dan `style.css?v=20260927` (cache-busting).

## 3. Fix: Folder Firmware Ikut Ter-upload ke Hosting

`https://isk-house.web.app/Firmware/src/main.cpp` bisa dibuka publik. Pola ignore `"Website/Firmware/**"` di `firebase.json` nggak pernah cocok karena dibaca **relatif terhadap folder public** (`Website`). Diganti jadi `"Firmware/**"`; sekarang yang ter-upload cuma 4 file website dan URL firmware balik 404. Ini penting karena firmware nanti butuh password WiFi & Database secret.

## 4. Firmware Gateway ↔ Firebase

Program gateway ditulis di [`Website/Firmware/src/main.cpp`](../../Website/Firmware/src/main.cpp) (PlatformIO, board `dfrobot_beetle_esp32c3`). Gabungan pairing HMAC dari [`Firmware/Gateway`](../../Firmware/Gateway/) + komunikasi Firebase. `Firmware/Gateway` sendiri **tidak diubah**.

| Bagian | Keputusan |
|--------|-----------|
| Login | **Database secret** (legacy token), tanpa akun email. Akses penuh, melewati Rules, jadi wajib dirahasiakan. |
| Kredensial | `include/secrets.h` (di-`.gitignore`), contoh di `include/secrets.example.h`. |
| Terima perubahan dari website | **Stream** ke node gateway; tiap event → baca ulang node → kirim perintah ESP-NOW ke doorlock kalau `status`/`rfidAccess` berubah. |
| Path Firebase | Key berisi spasi & koma → di-encode manual lewat `dbPath()`, karena library Firebase nggak nge-encode (gejalanya error `closed SSL connection`). |
| WiFi | Dicoba ulang tiap 10 detik; kalau gagal, gateway nge-scan dan nampilin apakah SSID terlihat + kekuatan sinyalnya. |
| Library | `mobizt/Firebase Arduino Client Library for ESP8266 and ESP32@^4.4.17`, `bblanchon/ArduinoJson@^7.2.0` |

Detail & hasil uji: [Test/Website/1. Gateway Firebase](../../Test/Website/1.%20Gateway%20Firebase/README.md).

## 5. Simulasi Status Doorlock

Doorlock fisik belum bisa kirim data, jadi Gateway bisa jadi **doorlock dummy** yang ngirim *heartbeat* tiap 5 detik lewat jalur kode yang sama dengan doorlock asli (`handleHeartbeat()`).

- **Baterai** diinput manual lewat Serial Monitor (`battery 101 75`), nggak berkurang sendiri. Notifikasi baterai lemah di ≤ 20%.
- **Terputus** kalau 15 detik nggak ada heartbeat. Penyebabnya ditebak dari data terakhir: baterai ≤ 5% → *baterai habis*; selain itu → *sinyal terputus / gangguan jaringan*.
- **RFID**: `rfid 101 block/allow` (tulis `rfidAccess` ke Firebase) dan `tap 101` (kartu ditempel: diterima → pintu terbuka lalu terkunci sendiri, diblokir → ditolak).
- **Status gateway sendiri** ditulis ke `gatewayStatus` tiap 30 detik: `lastSeen`, alasan restart (`esp_reset_reason()`), alasan putus WiFi (event `ARDUINO_EVENT_WIFI_STA_DISCONNECTED`).
- Perintah `help` nampilin semua perintah Serial.

Sempat diputuskan field `connection` **nggak** ditulis ke Firebase, lalu dimasukin lagi karena dibutuhin website buat badge Tersambung/Terputus.

Detail & hasil uji: [Test/Website/2. Simulasi Status Doorlock](../../Test/Website/2.%20Simulasi%20Status%20Doorlock/README.md).

## 6. Dashboard: Indikator Baterai & Status Koneksi

- **Kartu kamar:** ikon baterai + persen (hijau > 50%, kuning 21–50%, merah ≤ 20%, "Habis" di 0%), badge **Tersambung**/**Terputus** + penyebabnya, atau "Belum ada data dari doorlock".
- **Ringkasan gateway:** "Gateway tersambung · data terakhir X detik lalu" + penyebab restart/putus WiFi terakhir, atau **Gateway terputus** kalau `lastSeen` lebih tua dari 75 detik. Selama gateway terputus, status doorlock ditulis "Status tidak diketahui".
- Jam browser dikoreksi pakai `.info/serverTimeOffset`; tampilan di-render ulang tiap 10 detik.
- `gatewayStatus` ditambahin ke `GATEWAY_META_FIELDS` supaya nggak kebaca sebagai kamar.
- Edit kamar sekarang mempertahankan field status doorlock (`DEVICE_STATUS_FIELDS`); sebelumnya ketimpa `set()` dan hilang.

## 7. Tiga Gateway & Klasifikasi Otomatis

3 board ESP32-C3 dicolok bareng, semuanya pakai firmware yang sama:

| Port | MAC |
|------|-----|
| COM5 | `80:45:6B:18:8F:A4` |
| COM6 | `80:45:6B:18:7F:48` |
| COM9 | `80:45:6B:18:92:74` |

- `GATEWAY_PATH` dikosongkan: gateway nyari node yang `gatewayMac`-nya sama dengan MAC-nya; kalau belum ada, daftar ke `pendingGateways/{MAC}` → muncul di panel admin **Gateway Menunggu Klasifikasi**. Setelah diklasifikasikan, gateway nemuin lokasinya dalam ±15 detik.
- **Hotspot HP nolak ESP baru** walau sinyalnya kuat (-53 dBm), karena batas jumlah perangkat hotspot. Beres setelah batasnya dinaikin. Upaya nurunin daya pancar (`setTxPower`) nggak ngaruh dan dibatalin.
- **Bug `path not exist`:** library Firebase nganggep node yang belum ada sebagai *error*, bukan data kosong, jadi pendaftaran `pendingGateways` gagal. Diperbaiki pakai `pathNotExist()` (`FIREBASE_ERROR_PATH_NOT_EXIST`).
- `DUMMY_ROOMS "*"`: semua kamar di semua gateway otomatis dapat doorlock dummy, termasuk kamar yang ditambahin belakangan. Baterai dummy lanjut dari nilai terakhir di Firebase.
- Node **Gateway 1** (beserta Kamar 101 dan Lantai 1 yang jadi kosong) dihapus atas permintaan pemilik proyek, supaya ketiga gateway bisa diklasifikasikan ulang dari website.
- Proses `platformio device monitor` beberapa kali tertinggal di background walau terminalnya udah ditutup, bikin upload gagal `COM busy`, jadi harus dihentikan manual.

## 8. Pendaftaran Akun Tanpa Verifikasi Email

Verifikasi email dihapus; cukup nunggu persetujuan admin.

- Halaman **"Verifikasi Email Anda"** (`#verifyView`) beserta tombol *Saya Sudah Verifikasi* / *Kirim Ulang Email* dihapus dari [`index.html`](../../Website/index.html) dan [`main.js`](../../Website/main.js), begitu juga `sendEmailVerification()` dan pengecekan `emailVerified`.
- Setelah daftar, user langsung ke halaman **Menunggu Persetujuan Admin** ("Pendaftaran berhasil. Akun Anda sedang menunggu persetujuan admin…"), dan dashboard kebuka otomatis begitu disetujui.
- **Fix label loncat:** tanpa halaman verifikasi, form daftar dan listener `users/{uid}` bakal sama-sama bikin data user berbarengan, sehingga `meta/userCounter` naik dua kali (User-3 langsung jadi User-4). Sekarang data `users/{uid}` cuma dibuat di satu tempat (`handleUserRecord()`).

## 9. Panel Pengguna Terdaftar & Keluarkan User

Panel baru khusus admin di bawah *Persetujuan Pendaftar*: daftar semua user selain yang masih `pending`.

| User | Badge | Tombol |
|------|-------|--------|
| Admin | Admin | – (admin nggak bisa dikeluarkan) |
| Disetujui | Aktif | **Keluarkan** (pakai konfirmasi) |
| Dikeluarkan | Dikeluarkan + tanggal & nama admin | **Izinkan Lagi** |
| Ditolak | Ditolak | **Izinkan Lagi** |

- **Keluarkan** = `status: "removed"` + `removedAt` + `removedBy`. User yang lagi login langsung terlempar ke halaman **"Akun Dikeluarkan"**. Akun Firebase Auth-nya **nggak** ikut kehapus (butuh Admin SDK di server), tapi aksesnya ke data udah ditolak Rules.
- **Izinkan Lagi** = balik ke `approved`, `removedAt`/`removedBy` dihapus.

### Celah Keamanan Rules Ditutup

Sebelumnya [`database.rules.json`](../../database.rules.json) ngizinin tiap user nulis `users/{uid}` **miliknya sendiri** tanpa batas. Siapa pun bisa buka console browser lalu ngubah dirinya jadi `approved` atau bahkan `admin`, jadi persetujuan admin bisa dilewati. Sekarang user cuma boleh **membuat** datanya sendiri sekali, dengan `role: user` + `status: pending`; perubahan setelahnya cuma bisa dilakukan admin.

## 10. Gateway Cuma Bisa Ditambah Lewat Klasifikasi

Alurnya sekarang: **gateway nyala → masuk "Gateway Menunggu Klasifikasi" → diklasifikasikan admin → baru bisa diubah nama / dihapus.**

- Tombol **"+ Gateway"** dan modal *Tambah Gateway* dihapus. Tiap node gateway sekarang pasti punya `gatewayMac` dan tersambung ke perangkat asli.
- Tombol baru **Ubah Nama** di samping *Hapus*. Karena key gateway = namanya, ganti nama = pindahin seluruh isi node ke key baru lalu hapus key lama dalam **satu update atomik**. Perangkat gateway ikut pindah sendiri (dia nyari node lewat `gatewayMac`, bukan nama). Timer auto-kunci gateway itu dihentikan dulu supaya nggak nulis ulang ke nama lama, dan riwayat di `localStorage` ikut ganti nama (cuma di browser yang ngubah).
- **Hapus** gateway: konfirmasinya sekarang ngasih tahu bahwa gateway bakal muncul lagi di antrian klasifikasi selama perangkatnya masih nyala.
- Kalau lantai belum punya gateway, tombol Ubah Nama/Hapus disembunyikan dan diganti petunjuk buat ngeklasifikasikan gateway.
- Modal **Klasifikasikan Doorlock** juga nggak bisa bikin cabang/lantai/gateway baru lagi (sebelumnya ada opsi "+ Gateway Baru", jalan belakang buat bikin gateway manual). Pilihannya cuma gateway yang udah diklasifikasikan, dan gateway yang mem-pairing doorlock (`pendingDevices/{mac}/gatewayMac`) langsung terpilih.

## Pengujian (Sesi Terakhir)

Diuji otomatis pakai headless Chrome (`puppeteer-core`, dipasang sementara di luar repo) + akun uji sementara, lalu semua data uji dihapus lagi dan `meta/userCounter` dikembalikan.

| Pengujian | Hasil |
|-----------|-------|
| Alur daftar → setujui → keluarkan → izinkan lagi (lokal & situs live) | 9/9 lulus, dua kali |
| Rules di database live pakai token user biasa (bikin data sendiri pending diizinkan; approve diri sendiri, jadi admin, ubah user lain, baca `locations` saat pending ditolak) | 7/7 lulus |
| Alur gateway pakai perangkat COM5 asli (klasifikasi → ubah nama → perangkat ikut pindah → modal doorlock → hapus → balik ke antrian) | Semua perilaku sesuai; 1 "gagal" ternyata kesalahan skrip uji |

Emulator Firebase nggak bisa jalan (Java nggak terpasang), jadi Rules dicek sintaksnya pakai `--dry-run`, rules lama di-backup, baru diuji perilakunya di database live setelah deploy.

## Deploy

**URL: https://isk-house.web.app**, di-deploy beberapa kali lewat `npx firebase-tools deploy --only hosting --project isk-house`, terakhir setelah indikator baterai & koneksi.

## Commit Hari Ini

Branch `website`:

1. `refactor(website): riwayat disimpan di localStorage, bukan Firebase`
2. `feat(firmware): gateway terhubung ke Firebase Realtime Database`
3. `fix(website): matikan cache js/css/html agar update langsung terpakai`
4. `fix(website): folder Firmware tidak ikut ter-upload ke hosting`
5. `feat(firmware): gateway stream realtime Firebase & teruskan perintah via ESP-NOW`
6. `feat(firmware): gateway login pakai database secret & ubah status kamar via serial`
7. `feat(firmware): simulasi status doorlock (baterai, koneksi, RFID) & status gateway`
8. `feat(website): indikator baterai & status koneksi doorlock dan gateway`
9. `feat(firmware): pendaftaran otomatis multi-gateway & dummy untuk semua kamar`
10. `docs: catatan update website 27 September 2026 & object dictionary`
11. `feat(website): daftar tanpa verifikasi email, keluarkan user & gateway hanya lewat klasifikasi`
12. `docs: update catatan 27 September & object dictionary (user dikeluarkan, alur gateway)`

Branch `main`: `docs(website): dokumentasi pengujian gateway Firebase & simulasi status doorlock`

## Belum Dikerjakan / Bisa Lanjut Nanti

- **Firmware Doorlock** belum ngirim `DoorStatusMessage` (heartbeat) dan belum ngerti perintah `0xD0`; semua status di dashboard masih dari doorlock dummy di dalam Gateway.
- Doorlock wajib di **channel WiFi yang sama** dengan router/hotspot gateway (sempat channel 1, sekarang channel 6).
- Pesan ESP-NOW setelah pairing belum dienkripsi (PMK/LMK).
- Database secret sempat dikirim lewat chat: sebaiknya dibuat ulang di Firebase Console, lalu `secrets.h` diperbarui.
- Branch `main` belum punya `.gitignore` untuk `Website/Firmware/include/secrets.h`; hindari `git add .` di `main` sampai branch `website` di-merge.
- Riwayat cuma per-browser; kalau nanti butuh riwayat bersama antar admin, perlu tempat penyimpanan lain.
- User yang dikeluarkan masih punya akun Firebase Auth; hapus manual di Firebase Console → Authentication kalau perlu dihapus total.
- **User-1** dan **User-2** sudah tidak ada di `users` per akhir sesi ini (bukan terhapus oleh pengujian); perlu dikonfirmasi apakah memang dihapus manual.
- Lantai masih bisa ditambah manual (**+ Lantai**), dan cabang/lantai baru masih bisa dibuat dari modal *Klasifikasikan Gateway*.

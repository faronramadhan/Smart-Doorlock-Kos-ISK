# Catatan Update Website — 27 September 2026

Ringkasan hasil kerja hari ini: riwayat dipindah dari Firebase ke browser, dua perbaikan deploy, lalu yang paling besar, **firmware Gateway yang tersambung ke Firebase** ([`Website/Firmware/`](../../Website/Firmware/)) lengkap dengan simulasi status doorlock, tampilan status di dashboard, dan pendaftaran otomatis beberapa gateway sekaligus. Detail teknis per pengujian ada di [`Test/Website/`](../../Test/Website/) (branch `main`); nama variabel/field yang dipakai dibakukan di [Object Dictionary](Object%20Dictionary.md).

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

Branch `main`: `docs(website): dokumentasi pengujian gateway Firebase & simulasi status doorlock`

## Belum Dikerjakan / Bisa Lanjut Nanti

- **Firmware Doorlock** belum ngirim `DoorStatusMessage` (heartbeat) dan belum ngerti perintah `0xD0`; semua status di dashboard masih dari doorlock dummy di dalam Gateway.
- Doorlock wajib di **channel WiFi yang sama** dengan router/hotspot gateway (sempat channel 1, sekarang channel 6).
- Pesan ESP-NOW setelah pairing belum dienkripsi (PMK/LMK).
- Database secret sempat dikirim lewat chat: sebaiknya dibuat ulang di Firebase Console, lalu `secrets.h` diperbarui.
- Branch `main` belum punya `.gitignore` untuk `Website/Firmware/include/secrets.h`; hindari `git add .` di `main` sampai branch `website` di-merge.
- Riwayat cuma per-browser; kalau nanti butuh riwayat bersama antar admin, perlu tempat penyimpanan lain.

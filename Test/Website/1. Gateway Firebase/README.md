# Gateway Firebase

Percobaan pertama nyambungin Gateway ke Firebase Realtime Database, database yang sama yang dipakai dashboard website ([isk-house.web.app](https://isk-house.web.app)). Tujuannya: apa pun yang diubah admin di website (Buka/Kunci, Blokir/Izinkan RFID) langsung sampai ke Gateway, dan sebaliknya Gateway bisa ngubah status kamar di Firebase supaya website ikut berubah.

Kode lengkap ada di [Gateway.cpp](Gateway.cpp) (snapshot dari `Website/Firmware/src/main.cpp` di branch `website`, commit `5b55098`).

## Perangkat

| Perangkat | Board | Port |
|-----------|-------|------|
| Gateway   | DFRobot Beetle ESP32-C3 (MAC `80:45:6B:18:8F:A4`) | COM5 |

Jaringan: hotspot HP **2.4 GHz** (ESP32-C3 nggak bisa 5 GHz), kebetulan di channel 1.

## Struktur Database

Gateway baca/tulis ke struktur yang sama persis dengan yang dibuat website:

```
locations
  ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja   <- cabang
    Lantai 1                                                     <- lantai
      Gateway 1                                                  <- gateway (node yang dipantau)
        Kamar 101: { tenant, rfidAccess, status, unlockedAt, doorlockMac }
```

History (riwayat buka/kunci) **tidak** disimpan di Firebase, cuma di `localStorage` browser website. Jadi node kamar tetap kecil, dan ini penting buat RAM ESP32-C3 (lihat bagian Stream).

## Teori

### Firebase Realtime Database

Database berbentuk satu pohon JSON besar yang diakses lewat HTTPS. Tiap node punya alamat (path) sendiri, contoh `locations/.../Gateway 1/Kamar 101/status`. Website dan Gateway sama-sama "klien" database ini: website pakai SDK JavaScript, Gateway pakai library [Firebase ESP Client](https://github.com/mobizt/Firebase-ESP-Client).

### Login Pakai Database Secret

Rules database ([database.rules.json](../../../database.rules.json)) cuma ngizinin akun yang login (dan berstatus admin/approved) buat baca-tulis `locations`. Gateway nggak pakai akun email, tapi pakai **Database secret** (legacy token):

```cpp
fbConfig.database_url = DATABASE_URL;
fbConfig.signer.tokens.legacy_token = DATABASE_SECRET;
```

Secret ini ngasih akses **penuh** ke seluruh database dan melewati Rules. Konsekuensinya secret wajib dirahasiakan: siapa pun yang pegang bisa buka semua pintu. Makanya secret + password WiFi dipisah ke `include/secrets.h` yang di-`.gitignore`; yang di-commit cuma contohnya (`secrets.example.h`):

```cpp
#define WIFI_SSID        "ISI_SSID_WIFI"     // WiFi 2.4 GHz
#define WIFI_PASSWORD    "ISI_PASSWORD_WIFI"
#define DATABASE_SECRET  "ISI_DATABASE_SECRET"  // Firebase Console -> Project settings -> Service accounts -> Database secrets
```

### Stream (Realtime) vs Polling

Ada dua cara Gateway tahu kalau admin ngeklik sesuatu di website:

| Cara | Kerjanya | Kekurangan |
|------|----------|------------|
| Polling | Gateway nanya status tiap kamar bergiliran, terus-terusan | Lambat (20 kamar × ±200 ms = ±4 detik), boros request |
| **Stream** (dipakai) | Gateway buka 1 koneksi HTTPS yang dibiarkan terbuka, Firebase ngirim event tiap ada perubahan di node gateway | Butuh 1 koneksi TLS terus-menerus (±40 KB RAM) |

Stream baru masuk akal setelah history dipindah dari Firebase. Sebelumnya tiap kamar bisa nyimpen sampai 1000 entri history, dan event stream pertama bakal ngirim seluruh isinya sekaligus, kebesaran buat RAM ESP32-C3.

### URL Encoding Path

Key di database berisi spasi dan koma (`ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja`). Library Firebase **nggak** meng-encode path, jadi request HTTP-nya rusak dan muncul error `Cannot operate on a closed SSL connection`. Solusinya path di-encode manual (spasi → `%20`, koma → `%2C`) sebelum tiap request:

```cpp
String dbPath(const String &path) {
  String out;
  for (size_t i = 0; i < path.length(); i++) {
    char c = path[i];
    if (isalnum((unsigned char)c) || c == '/' || c == '-' || c == '_' || c == '.' || c == '~' || c == ':') {
      out += c;
    } else {
      char buf[4];
      snprintf(buf, sizeof(buf), "%%%02X", (uint8_t)c);
      out += buf;
    }
  }
  return out;
}
```

### Server Timestamp

Waktu `unlockedAt` diisi pakai `{".sv": "timestamp"}`, yaitu jam server Firebase, bukan jam ESP32 (ESP32 nggak punya RTC yang pasti bener):

```cpp
update.set("unlockedAt/.sv", "timestamp");
```

## Library

| Library | Fungsi |
|---------|--------|
| `WiFi.h` | Konek ke hotspot/router (`WiFi.begin`), baca MAC & channel. |
| `Firebase_ESP_Client.h` | `mobizt/Firebase Arduino Client Library for ESP8266 and ESP32` — login, `get`, `updateNode`, `beginStream`/`readStream`. |
| `ArduinoJson.h` | `bblanchon/ArduinoJson@^7` — parse isi node gateway jadi daftar kamar. |
| `Preferences.h` | Simpan path gateway hasil pencarian otomatis ke flash (NVS). |
| `esp_now.h`, `mbedtls/md.h` | Pairing Doorlock HMAC dari [Test Firmware 2](../../Firmware/2.%20Autentikasi%20HMAC/), digabung ke gateway ini. |

Tambahan di `platformio.ini`:

```ini
monitor_speed = 115200
lib_deps =
	mobizt/Firebase Arduino Client Library for ESP8266 and ESP32@^4.4.17
	bblanchon/ArduinoJson@^7.2.0
```

## Program

### Lokasi Gateway

```cpp
#define GATEWAY_PATH "locations/ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja/Lantai 1/Gateway 1"
```

"Gateway 1" dibikin manual dari dashboard, jadi nggak punya field `gatewayMac`. Path-nya ditulis langsung di kode. Kalau dikosongkan (`""`), Gateway nyari sendiri node yang `gatewayMac`-nya sama dengan MAC-nya (hasil klasifikasi admin), dan kalau belum ada, dia daftar ke `pendingGateways/{MAC}` supaya muncul di panel admin.

### Loop Utama

```cpp
if (!streaming) { startStream(); return; }

handleStream();          // ada event dari Firebase -> roomsDirty = true
if (roomsDirty) {
  roomsDirty = false;
  refreshRooms();        // baca ulang node gateway, bandingkan dengan data lama
}
```

`refreshRooms()` baca seluruh node gateway (kecil, tanpa history), terus bandingin tiap kamar dengan data sebelumnya. Kalau `status` atau `rfidAccess` berubah, Gateway manggil `sendDoorlockCommand()` yang ngirim perintah ke Doorlock lewat ESP-NOW (2 byte: header `0xD0` + kode `LOCK`/`UNLOCK`/`RFID_ALLOW`/`RFID_BLOCK`). Perintah **nggak** dikirim waktu kamar pertama kali kebaca, cuma waktu ada perubahan.

### Gateway Ngubah Status Kamar

```cpp
bool setRoomStatus(Room *r, bool unlocked, const char *source) {
  r->status = unlocked ? "unlocked" : "locked";   // update lokal duluan
  ...
  update.set("status", r->status);
  if (unlocked) update.set("unlockedAt/.sv", "timestamp");
  Firebase.RTDB.updateNode(&fbdo, dbPath(roomPath), &update);
```

Status lokal di-update **sebelum** nulis ke Firebase. Tulisan itu bakal balik lagi ke Gateway sebagai event stream; karena status lokal udah sama, `refreshRooms()` nggak nganggep itu perubahan baru, jadi nggak ada perintah dobel ke Doorlock.

### WiFi Coba Ulang

```cpp
for (int attempt = 1; WiFi.status() != WL_CONNECTED; attempt++) {
  delay(500);
  if (attempt % 20 == 0) {           // tiap 10 detik
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}
```

ESP32-C3 sempat nyangkut nggak mau konek ke hotspot setelah beberapa kali reset, padahal laptop konek ke hotspot yang sama. Dengan dicoba ulang tiap 10 detik, langsung konek lagi.

### Perintah Serial

| Perintah | Fungsi |
|----------|--------|
| `rooms` | Daftar kamar + status + RFID + doorlock |
| `unlock 101` / `lock 101` | Ubah status Kamar 101 di Firebase + kirim perintah ke doorlock-nya |
| `unlock AA:BB:CC:DD:EE:FF` / `lock ...` | Simulasi laporan buka/kunci dari doorlock (butuh `doorlockMac` di kamar) |
| `pair AA:BB:CC:DD:EE:FF` | Simulasi doorlock lolos pairing → masuk `pendingDevices` |
| `Pairing` | Aktifkan pairing ESP-NOW 60 detik |

## Test Procedure

1. Salin `include/secrets.example.h` jadi `include/secrets.h`, isi SSID, password WiFi, dan Database secret.
2. Upload [Gateway.cpp](Gateway.cpp) sebagai `Website/Firmware/src/main.cpp` lewat PlatformIO (COM5).
3. Buka Serial Monitor (115200). Tunggu sampai muncul `[STREAM] Memantau locations/...`.
4. Ketik `rooms`, pastiin Kamar 101 kebaca.
5. Klik **Buka**/**Kunci** dan **Blokir RFID**/**Izinkan RFID** di website, pastiin Serial nampilin `[CMD] ...`.
6. Ketik `unlock 101` lalu `lock 101`, pastiin status di website/Firebase Console ikut berubah.
7. Ketik `unlock 999`, pastiin ditolak karena kamarnya nggak ada.

## Hasil Pengujian

### Firebase → Gateway

| Perubahan di Firebase | Output Serial |
|-----------------------|---------------|
| `status` → `unlocked` | `[CMD] UNLOCK -> Kamar 101 dilewati (belum ada doorlock).` |
| `status` → `locked` | `[CMD] LOCK -> Kamar 101 dilewati (belum ada doorlock).` |
| `rfidAccess` → `false` | `[CMD] RFID_BLOCK -> Kamar 101 dilewati (belum ada doorlock).` |
| `rfidAccess` → `true` | `[CMD] RFID_ALLOW -> Kamar 101 dilewati (belum ada doorlock).` |

"Dilewati" karena Kamar 101 belum punya `doorlockMac`. Yang dibuktikan di sini adalah perubahan dari website langsung sampai ke Gateway lewat stream.

### Gateway → Firebase

| Perintah Serial | Output Serial | `status` di Firebase |
|-----------------|---------------|----------------------|
| `rooms` | `Kamar 101 \| locked \| RFID izin \| doorlock -` | locked |
| `unlock 101` | `[GATEWAY] Kamar 101 unlocked (diubah lewat Serial Monitor).` | **unlocked** |
| `lock 101` | `[GATEWAY] Kamar 101 locked (diubah lewat Serial Monitor).` | **locked** |
| `unlock 999` | `Kamar 999 tidak ada di gateway ini (cek dengan "rooms").` | tidak berubah |
| `unlock AA:BB:CC:DD:EE:01`* | `[GATEWAY] Kamar 101 unlocked (dilaporkan doorlock).` | **unlocked** |

\* Dengan `doorlockMac: "AA:BB:CC:DD:EE:01"` dipasang sementara di Kamar 101, lalu dihapus lagi setelah uji.

### Observasi

- **Path tanpa encoding bikin request gagal diam-diam.** Stream "mulai" tapi daftar kamar kosong dan muncul `Cannot operate on a closed SSL connection`. Dicek pakai `curl`: path dengan `%20`/`%2C` berhasil, path mentah gagal. Solusinya `dbPath()`.
- **Browser nyimpen `main.js` lama sampai 1 jam** (`Cache-Control: max-age=3600`), jadi website versi lama masih nulis history ke Firebase padahal versi baru udah di-deploy. Diperbaiki di `firebase.json` pakai header `no-cache` untuk js/css/html.
- **Upload gagal `COM5 busy`** kalau Serial Monitor masih kebuka, termasuk proses `platformio device monitor` yang ketinggalan di background walau terminalnya udah ditutup.
- **Doorlock belum bisa nerima perintah Gateway.** ESP-NOW ikut channel router WiFi (di sini channel 1), jadi Doorlock juga wajib di channel yang sama, dan firmware Doorlock belum ngerti pesan `0xD0`.

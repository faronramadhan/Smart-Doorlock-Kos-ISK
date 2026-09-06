# Broadcast MAC Address

Uji coba komunikasi dasar antara Doorlock dan Gateway lewat ESP-NOW, sebelum masuk ke logic pairing yang sesungguhnya. Tujuannya cuma satu: memastikan Doorlock bisa broadcast MAC address-nya sendiri, dan Gateway bisa nangkep siaran itu lalu mendaftarkannya sebagai peer.

## Perangkat

| Perangkat | Board | Port |
|-----------|-------|------|
| Doorlock  | DFRobot Beetle ESP32-C3 | COM23 |
| Gateway   | DFRobot Beetle ESP32-C3 | COM15 |

## Teori

### ESP-NOW

ESP-NOW adalah protokol komunikasi nirkabel buatan Espressif yang jalan di atas radio 2.4GHz WiFi, tapi **tidak butuh router/access point**. Dua ESP32 bisa langsung saling kirim data selama:

1. Sama-sama mengaktifkan ESP-NOW.
2. Berada di **channel WiFi yang sama**.

Analoginya lebih mirip walkie-talkie ketimbang koneksi internet biasa — device saling "dengar" langsung tanpa perantara.

### Channel WiFi

Spektrum radio 2.4GHz dibagi jadi beberapa "jalur" terpisah bernomor 1–13 (di Indonesia). Ini fungsinya biar banyak device bisa pakai udara yang sama tanpa saling menumpuk sinyal — mirip stasiun radio FM yang siaran di frekuensi berbeda. Dua device ESP-NOW **wajib** berada di channel yang identik supaya bisa saling dengar; beda channel berarti gak akan pernah nyambung sama sekali, walau jaraknya dekat.

Channel juga bukan properti per-hubungan (per-peer), melainkan properti radio itu sendiri — satu ESP32 cuma bisa aktif di satu channel dalam satu waktu, tapi channel yang sama bisa ditumpangi banyak device dan banyak "obrolan" sekaligus.

### Broadcast Address

`FF:FF:FF:FF:FF:FF` adalah alamat MAC khusus yang berarti "semua orang yang mendengar", bukan MAC asli suatu device. Paket yang dikirim ke alamat ini akan diterima oleh **semua** device ESP-NOW yang aktif di channel yang sama — bukan cuma satu penerima spesifik. Ini dipakai Doorlock untuk "berteriak" ke jaringan tanpa perlu tahu dulu siapa yang bakal dengar.

Konsekuensi dari sifat broadcast: paket ke alamat ini **tidak bisa dienkripsi** oleh ESP-NOW, karena enkripsi butuh kunci yang spesifik ke satu peer, sedangkan broadcast tidak ditujukan ke peer tertentu.

### Peer

Di ESP-NOW, "peer" adalah entri di tabel internal yang menandai satu alamat MAC sebagai tujuan kirim yang sah. Sebelum bisa `esp_now_send()` ke suatu alamat (termasuk alamat broadcast), alamat itu wajib didaftarkan lebih dulu lewat `esp_now_add_peer()` — kalau tidak, pengiriman akan ditolak.

Penting dicatat: pendaftaran peer ini **hanya diperlukan untuk mengirim**. Untuk menerima, ESP-NOW callback (`esp_now_register_recv_cb`) akan tetap terpanggil untuk paket dari MAC manapun yang mengirim ke device ini, tanpa perlu MAC itu terdaftar sebagai peer terlebih dulu — inilah yang membuat Gateway bisa "mendengar" MAC Doorlock padahal belum pernah mendaftarkannya di awal.

### Callback (arsitektur event-driven)

Fungsi `onReceive()` di kedua program **tidak pernah dipanggil manual** di kode. Fungsi ini didaftarkan lewat `esp_now_register_recv_cb()` di `setup()`, lalu dijalankan otomatis oleh sistem setiap kali ada paket ESP-NOW yang masuk — mirip alarm yang otomatis bunyi tanpa perlu dicek terus-menerus. Pola ini disebut event-driven / interrupt-driven, berbeda dengan `loop()` yang jalan terus-menerus secara aktif (disebut polling).

## Library

| Library | Fungsi |
|---------|--------|
| `Arduino.h` | Framework dasar Arduino — menyediakan tipe `String`, fungsi `Serial`, `millis()`, `delay()`, dan struktur `setup()`/`loop()`. |
| `WiFi.h` | Kontrol radio WiFi ESP32 — dipakai di sini hanya untuk `WiFi.mode(WIFI_STA)` (mengaktifkan radio tanpa connect ke access point manapun) dan `WiFi.macAddress()` (membaca MAC address device sendiri). |
| `esp_now.h` | API protokol ESP-NOW dari ESP-IDF — menyediakan `esp_now_init()`, `esp_now_add_peer()`, `esp_now_send()`, `esp_now_register_recv_cb()`, dan tipe data `esp_now_peer_info_t`. |

## Program

### Doorlock.cpp

```cpp
uint8_t broadcastAddress[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
```
Konstanta alamat broadcast ESP-NOW — lihat penjelasan konsep di atas.

```cpp
bool broadcasting = false;
```
Status: apakah Doorlock sedang dalam mode broadcast atau masih idle menunggu perintah.

```cpp
void setup() {
  Serial.begin(115200);
```
Menyalakan komunikasi serial ke komputer (lewat USB) dengan kecepatan 115200 baud, dipakai untuk membaca perintah dan mencetak status ke Serial Monitor.

```cpp
  WiFi.mode(WIFI_STA);
```
Mengaktifkan radio WiFi dalam mode Station. ESP-NOW butuh radio WiFi menyala walau tidak connect ke access point manapun.

```cpp
  esp_now_init();
```
Menyalakan protokol ESP-NOW pada radio yang sudah diaktifkan sebelumnya. Wajib dipanggil sebelum fungsi ESP-NOW lain manapun.

```cpp
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddress, 6);
  esp_now_add_peer(&peer);
```
Mendaftarkan alamat broadcast sebagai peer yang sah untuk dikirimi data. `esp_now_peer_info_t peer = {}` membuat struct kosong (semua field default, termasuk `encrypt = false`), lalu `memcpy` menyalin 6 byte alamat broadcast ke field `peer_addr`-nya. Tanpa langkah ini, `esp_now_send()` ke alamat broadcast akan gagal.

```cpp
void loop() {
  if (!broadcasting && Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Pairing") {
      Serial.println(WiFi.macAddress());
      broadcasting = true;
    }
  }
```
Selama belum dalam mode broadcast, `loop()` mengecek apakah ada data masuk dari Serial Monitor (`Serial.available()`). Kalau ada, baca satu baris teks sampai karakter newline (`readStringUntil('\n')`), buang spasi/karakter newline sisa di ujungnya (`trim()`), lalu bandingkan persis dengan teks `"Pairing"`. Kalau cocok: cetak MAC address sendiri sekali, lalu set `broadcasting = true` supaya blok kode berikutnya mulai aktif.

```cpp
  if (broadcasting) {
    String mac = WiFi.macAddress();
    esp_now_send(broadcastAddress, (uint8_t*)mac.c_str(), mac.length() + 1);
    Serial.println("Pairing...");
    delay(500);
  }
}
```
Selama `broadcasting` bernilai `true`: ambil MAC address sendiri sebagai teks, kirim ke alamat broadcast lewat `esp_now_send()` (di-cast ke `uint8_t*` karena fungsi ini bekerja dengan data mentah/byte, bukan tipe `String`; panjang datanya ditambah 1 untuk menyertakan karakter null-terminator di akhir string), cetak `"Pairing..."` ke Serial Monitor sebagai indikator visual, lalu jeda 500 milidetik sebelum mengulang siklus ini selamanya (selama belum ada mekanisme untuk mematikannya kembali).

### Gateway.cpp

```cpp
bool listening = false;
bool connected = false;
```
Dua status independen: `listening` menandai apakah Gateway sedang aktif mendengarkan paket ESP-NOW, dan `connected` menandai apakah sudah ada satu Doorlock yang berhasil didaftarkan sebagai peer.

```cpp
void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (!listening) return;
```
Fungsi callback yang dipanggil otomatis oleh sistem ESP-NOW setiap ada paket masuk dari MAC manapun (lihat konsep Callback di atas). Tiga parameternya: `mac` (alamat MAC pengirim sebenarnya, dibaca langsung dari header radio — bukan dari isi pesan), `data` (isi pesan mentah dalam bentuk byte), dan `len` (panjang data dalam byte). Baris `if (!listening) return` membuat fungsi ini langsung berhenti tanpa melakukan apa-apa kalau Gateway belum diperintah masuk mode listen.

```cpp
  char macStr[18];
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.print("MAC terdeteksi: ");
  Serial.println(macStr);
```
Mengubah 6 byte mentah alamat MAC pengirim menjadi teks yang mudah dibaca manusia, format standar heksadesimal dipisah titik dua (contoh: `80:45:6B:18:82:28`). Ukuran buffer `18` dihitung dari: 6 pasang digit heksadesimal (12 karakter) + 5 titik dua pemisah + 1 karakter null-terminator = 18. Hasilnya langsung dicetak ke Serial Monitor.

```cpp
  if (!connected) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, mac, 6);
    esp_now_add_peer(&peer);
    connected = true;

    Serial.print("Connect ke: ");
    Serial.println(macStr);
  }
}
```
Kalau belum ada peer yang terdaftar sebelumnya, MAC pengirim yang baru saja terdeteksi langsung didaftarkan sebagai peer (`esp_now_add_peer`), status `connected` diubah jadi `true`, dan konfirmasi dicetak. Tidak ada filter atau validasi apapun terhadap MAC ini — siapapun (device ESP-NOW manapun) yang pertama kali mengirim paket saat `listening` aktif akan langsung dipercaya dan didaftarkan. Peer berikutnya yang terdeteksi setelah ini akan tetap dicetak MAC-nya (karena baris print ada di luar blok `if (!connected)`), tapi tidak lagi didaftarkan ulang.

```cpp
void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);
}
```
Inisialisasi serial dan radio WiFi (sama seperti Doorlock), lalu `esp_now_register_recv_cb(onReceive)` mendaftarkan fungsi `onReceive` sebagai callback yang akan dipanggil otomatis oleh sistem setiap ada paket ESP-NOW masuk. Perhatikan: Gateway **tidak** memanggil `esp_now_add_peer()` untuk alamat broadcast di `setup()` — ini karena Gateway pada tahap ini tidak pernah mengirim data, hanya menerima, dan menerima tidak membutuhkan pendaftaran peer terlebih dulu.

```cpp
void loop() {
  if (!listening && Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Pairing") {
      listening = true;
      Serial.println("Masuk mode listen...");
    }
  }
}
```
Sama seperti Doorlock: menunggu perintah teks `"Pairing"` dari Serial Monitor. Begitu cocok, `listening` diubah jadi `true`, mengaktifkan pemrosesan paket di dalam `onReceive()` (yang sebelumnya langsung `return` di baris pertama).

## Test Procedure

1. Upload `Doorlock.cpp` ke board Doorlock, `Gateway.cpp` ke board Gateway (lewat project PlatformIO masing-masing di `Firmware/`).
2. Buka **dua** serial monitor terpisah (satu ke COM23, satu ke COM15) — jangan tutup salah satu buat buka yang lain, karena membuka ulang koneksi serial memicu auto-reset board (lewat toggle DTR/RTS ke pin EN) dan mengembalikan state broadcasting/listening ke awal.
3. Ketik `Pairing` (dengan line ending **Newline**) di kedua serial monitor.
4. Gateway akan mencetak MAC address Doorlock berulang kali, lalu mencetak baris `Connect ke: ...` sekali di awal.

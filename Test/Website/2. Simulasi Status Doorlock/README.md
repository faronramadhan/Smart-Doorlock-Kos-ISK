# Simulasi Status Doorlock

Lanjutan dari [Gateway Firebase](../1.%20Gateway%20Firebase/). Doorlock fisik belum bisa kirim data ke Gateway, jadi Gateway dibikin bisa **pura-pura jadi Doorlock** (dummy) yang ngirim status berkala: indikator baterai, posisi kunci, dan kejadian kartu RFID. Gateway juga ngedeteksi kalau Doorlock terputus beserta **penyebabnya** (baterai habis atau masalah sinyal/jaringan), dan ngelapor status dirinya sendiri. Semua status ini ditampilin di dashboard website.

Kode lengkap ada di [Gateway.cpp](Gateway.cpp) (snapshot dari `Website/Firmware/src/main.cpp` di branch `website`, commit `c3e74f9`). Tampilan website ada di commit `86921fb` (`Website/main.js`, `Website/style.css`).

## Perangkat

| Perangkat | Board | Port |
|-----------|-------|------|
| Gateway (+ Doorlock dummy) | DFRobot Beetle ESP32-C3 (MAC `80:45:6B:18:8F:A4`) | COM5 |

## Struktur Database

Field baru yang ditulis Gateway (ditandai ★):

```
Gateway 1
  gatewayStatus ★                  <- laporan Gateway sendiri, tiap 30 detik
    lastSeen                       <- server timestamp, dipakai website buat nentuin online/offline
    lastRestartReason, lastRestartAt
    lastDisconnectReason, lastDisconnectSeconds, lastReconnectAt
  Kamar 101
    tenant, rfidAccess, status, unlockedAt, doorlockMac
    battery ★                      <- 0-100 (%)
    connection ★                   <- "connected" / "disconnected"
    connectionReason ★             <- mis. "Baterai doorlock habis (0%), doorlock mati"
    connectionUpdatedAt ★
```

`gatewayStatus` bentuknya object, sama kayak kamar. Supaya nggak kebaca sebagai "kamar hantu", key ini dilewati di `refreshRooms()` Gateway dan dimasukin ke `GATEWAY_META_FIELDS` di website.

## Teori

### Heartbeat

Doorlock ngirim pesan status kecil secara berkala (tiap 5 detik), disebut *heartbeat*. Isinya cukup 3 byte:

```cpp
#define DOOR_STATUS_HEADER 0xD1
typedef struct {
  uint8_t header;    // 0xD1
  uint8_t battery;   // 0-100 %
  uint8_t unlocked;  // 1 = terbuka, 0 = terkunci
} DoorStatusMessage;
```

Panjangnya (3 byte) sengaja beda dari pesan ESP-NOW lain (TAG 4 byte, `AuthMessage` 8 byte, perintah 2 byte), jadi Gateway bisa bedain jenis pesan cukup dari panjang + header.

### Deteksi Terputus & Penyebabnya

Doorlock yang mati atau keluar jangkauan **nggak bisa ngabarin** bahwa dia terputus; heartbeat-nya cuma berhenti datang. Gateway nganggep Doorlock terputus kalau 3× heartbeat nggak datang (15 detik), terus nebak penyebabnya dari data terakhir yang dia terima:

| Kondisi terakhir | Penyebab yang dicatat |
|------------------|------------------------|
| Baterai terakhir ≤ 5% | `Baterai doorlock habis (terakhir X%)` |
| Selain itu | `Sinyal terputus, doorlock di luar jangkauan gateway atau ada gangguan jaringan` |
| Doorlock sempat kirim pesan pamit `EVT_BATTERY_SHUTDOWN` (`0xD0 0x13`) | `Baterai doorlock habis, doorlock mati` (langsung, tanpa nunggu 15 detik) |

### Status Gateway Sendiri

Website nggak bisa nanya langsung ke Gateway, jadi Gateway nulis `gatewayStatus/lastSeen` tiap 30 detik. Website nganggep Gateway **offline** kalau `lastSeen` lebih tua dari 75 detik. Selisih jam browser dan jam server dikoreksi pakai `.info/serverTimeOffset`.

Penyebab kejadian diambil dari ESP32 sendiri, lalu dilaporkan begitu Gateway online lagi:

| Sumber | Contoh teks |
|--------|-------------|
| `esp_reset_reason()` waktu nyala | `Gateway dinyalakan (listrik sempat mati atau kabel dicabut)`, `Tegangan listrik gateway turun (brownout)`, `Gateway restart karena error program` |
| Event `ARDUINO_EVENT_WIFI_STA_DISCONNECTED` | `WiFi tidak ditemukan (router/hotspot mati atau di luar jangkauan)`, `Sinyal WiFi hilang ...`, `Password WiFi ditolak router` |

## Program

### Konfigurasi Simulasi

```cpp
#define HEARTBEAT_INTERVAL_MS 5000   // doorlock mengirim status tiap 5 detik
#define HEARTBEAT_TIMEOUT_MS  15000  // 3x status tidak datang -> dianggap terputus
#define BATTERY_LOW           20     // % -> notifikasi baterai lemah
#define BATTERY_EMPTY         5      // % -> kalau terputus di bawah ini, penyebabnya baterai habis
#define GATEWAY_HEARTBEAT_MS  30000  // gateway melapor "masih hidup" tiap 30 detik
#define SIM_AUTO_LOCK_MS      5000   // doorlock simulasi mengunci sendiri 5 detik setelah dibuka kartu

#define DUMMY_ROOMS           "101"  // kamar yang otomatis disimulasikan saat gateway menyala ("" = mati)
#define DUMMY_BATTERY         100    // baterai awal dummy (%)
```

Baterai dummy **nggak berkurang sendiri**. Nilainya cuma berubah lewat perintah `battery` di Serial Monitor (input manual).

### Satu Jalur untuk Doorlock Asli dan Simulasi

```cpp
// Doorlock asli: pesan ESP-NOW -> antrian -> loop()
case EVT_HEARTBEAT:
  if (r) handleHeartbeat(*r, ev.battery, ev.unlocked);

// Doorlock simulasi: dipanggil langsung dari runSimulations() tiap 5 detik
handleHeartbeat(r, r.simBattery, r.status == "unlocked");
```

Simulasi sengaja lewat fungsi yang sama (`handleHeartbeat`, `checkHeartbeatTimeouts`) dengan Doorlock asli. Jadi yang diuji sekarang juga logika yang nanti dipakai begitu firmware Doorlock udah ngirim `DoorStatusMessage`.

`handleHeartbeat()` cuma nulis ke Firebase kalau ada yang **berubah** (tersambung lagi, atau angka baterai beda), bukan tiap 5 detik, supaya hemat request.

### Simulasi RFID

```cpp
void simulateCardTap(Room &r) {
  if (r.simBattery <= 0) { /* doorlock mati, kartu nggak kebaca */ }
  if (!r.rfidAccess)     { /* [NOTIF] kartu RFID DITOLAK */ }
  if (!r.online)         { /* pintu kebuka lokal, tapi nggak bisa dilaporin ke gateway */ }
  setRoomStatus(&r, true, "dibuka dengan kartu RFID");   // lalu terkunci lagi setelah SIM_AUTO_LOCK_MS
}
```

`rfid 101 block/allow` nulis `rfidAccess` ke Firebase (sama kayak tombol di website), lalu ngirim perintah `RFID_BLOCK`/`RFID_ALLOW` ke Doorlock.

### Tampilan Website

- **Kartu kamar:** ikon baterai + persen (hijau > 50%, kuning 21–50%, merah ≤ 20%, tulisan "Habis" di 0%), badge **Tersambung** / **Terputus** + penyebabnya. Kamar tanpa data nampilin "Belum ada data dari doorlock".
- **Ringkasan gateway:** titik hijau "Gateway tersambung · data terakhir X detik lalu" + penyebab restart/putus WiFi terakhir (24 jam), atau titik merah "Gateway terputus sejak HH.MM" kalau offline. Selama gateway offline, status doorlock ditulis "Status tidak diketahui", karena datanya udah nggak diperbarui.
- Website nge-render ulang tiap 10 detik, soalnya status online/offline dihitung dari umur `lastSeen`, bukan dari event data.
- Field `battery`/`connection`/... dipertahankan waktu kamar diedit dari website (sebelumnya ketimpa `set()` dan hilang).

## Perintah Serial

Ketik `help` di Serial Monitor buat nampilin daftar ini.

| Perintah | Fungsi |
|----------|--------|
| `help` | Tampilkan semua perintah |
| `rooms` | Daftar kamar: status, RFID, baterai, koneksi doorlock |
| `Pairing` | Aktifkan pairing doorlock ESP-NOW (60 detik) |
| `reset` | Cari ulang lokasi gateway (hanya kalau `GATEWAY_PATH` kosong) |
| `unlock 101` / `lock 101` | Buka / kunci Kamar 101 |
| `rfid 101 block` / `rfid 101 allow` | Blokir / izinkan kartu RFID Kamar 101 |
| `sim 101` / `sim 101 stop` | Mulai / hentikan simulasi doorlock (dummy `DUMMY_ROOMS` aktif otomatis) |
| `battery 101 75` | Input manual baterai (0 = habis & doorlock mati, isi lagi = menyala) |
| `signal 101 off` / `on` | Putus / sambung sinyal doorlock (terputus kedeteksi setelah 15 detik) |
| `tap 101` | Tempel kartu RFID |
| `pair AA:BB:CC:DD:EE:FF` | Simulasi doorlock lolos pairing → panel admin website |
| `unlock AA:BB:…` / `lock AA:BB:…` | Simulasi laporan buka/kunci dari doorlock asli |

## Test Procedure

1. Upload [Gateway.cpp](Gateway.cpp) sebagai `Website/Firmware/src/main.cpp` (butuh `include/secrets.h`, lihat [Test 1](../1.%20Gateway%20Firebase/)).
2. Buka Serial Monitor. Tunggu `[STREAM] Memantau ...` dan `[SIM] Dummy doorlock Kamar 101 dimulai`.
3. Buka website, **Ctrl+Shift+R**, masuk ke ISK House Kemayoran → Lantai 1 → Gateway 1.
4. Jalankan skenario di tabel hasil di bawah satu per satu, lalu cocokin output Serial, Firebase Console, dan tampilan website.
5. Cabut USB board (atau matiin hotspot) ±2 menit, pastiin website nampilin **Gateway terputus**. Colok lagi, pastiin kembali tersambung dengan keterangan penyebabnya.

## Hasil Pengujian

### Baterai & Koneksi Doorlock

| Perintah | Notifikasi Serial | Firebase |
|----------|-------------------|----------|
| (gateway menyala) | `doorlock TERSAMBUNG ke gateway (baterai 100%)` | `battery: 100`, `connection: connected` |
| `battery 101 45` | `Baterai doorlock Kamar 101 diubah ke 45%` | `battery: 45` |
| `battery 101 10` | `baterai doorlock lemah (10%), segera ganti/isi ulang` | `battery: 10` |
| `battery 101 0` | `doorlock TERPUTUS dari gateway - Baterai doorlock habis (0%), doorlock mati` | `battery: 0`, `connection: disconnected` |
| `battery 101 80` | `doorlock TERSAMBUNG ke gateway (baterai 80%)` | `battery: 80`, `connection: connected` |
| `signal 101 off` | (15 detik kemudian) `TERPUTUS - Sinyal terputus, doorlock di luar jangkauan gateway atau ada gangguan jaringan` | `connectionReason` sesuai |
| `unlock 101` saat terputus | `UNLOCK -> Kamar 101 tidak sampai, doorlock terputus (...)` | `status` tetap berubah |
| `signal 101 on` | `doorlock TERSAMBUNG ke gateway (baterai X%)`, X = baterai terakhir | `connection: connected` |

### RFID

| Perintah | Notifikasi Serial | Firebase |
|----------|-------------------|----------|
| `rfid 101 block` | `Kartu RFID Kamar 101 DIBLOKIR` + `[SIM] ... akses kartu RFID DIBLOKIR, kartu akan ditolak` | `rfidAccess: false` |
| `tap 101` | `kartu RFID DITOLAK, akses kartu sedang diblokir` | tidak berubah |
| `rfid 101 allow` | `Kartu RFID Kamar 101 DIIZINKAN` + `[SIM] ... kartu bisa membuka pintu` | `rfidAccess: true` |
| `tap 101` | `kartu RFID DITERIMA, pintu terbuka (terkunci otomatis dalam 5 detik)` | `status: unlocked` → `locked` |
| `tap 101` (baterai 0%) | `Kartu ditempel di Kamar 101, tapi doorlock mati (baterai habis)` | tidak berubah |

### Status Gateway

| Kejadian | Firebase `gatewayStatus` |
|----------|--------------------------|
| Upload program / reset lewat USB | `lastRestartReason: "Gateway dinyalakan ulang (reset lewat USB / upload program)"`, `lastSeen` diperbarui tiap 30 detik |

### Observasi

- **Tulisan Gateway sendiri balik lagi sebagai event stream.** Tiap heartbeat yang ngubah baterai → stream event → `refreshRooms()` baca ulang node gateway. Supaya status simulasi (yang cuma ada di RAM) nggak hilang, `copyRuntimeState()` nyalin state lama ke data kamar yang baru dibaca.
- **Auto-kunci website lebih cepat dari auto-kunci doorlock simulasi.** Waktu `tap 101` diuji dengan dashboard kebuka, yang ngunci duluan adalah timer website (5 detik), jadi doorlock simulasi nerima perintah `LOCK` alih-alih ngunci sendiri. Hasil akhirnya sama.
- **Penyebab terputus cuma tebakan.** Gateway nggak bisa tahu pasti kenapa heartbeat berhenti; dia nyimpulin dari baterai terakhir. Doorlock yang baterainya drop mendadak dari 50% ke 0% bakal kecatat "Sinyal terputus". Doorlock asli sebaiknya kirim `EVT_BATTERY_SHUTDOWN` sebelum mati.
- **Status di website bisa telat sampai ±10 detik** karena render ulang tiap 10 detik, ditambah 15 detik deteksi terputus di Gateway.
- **Firmware Doorlock asli belum ngirim `DoorStatusMessage`** dan belum ngerti perintah `0xD0`. Semua hasil di atas masih dari Doorlock dummy di dalam Gateway.

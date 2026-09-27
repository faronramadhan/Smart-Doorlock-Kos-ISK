# Object Dictionary

Kamus nama variabel, field database, dan pesan antar-perangkat untuk project ini, biar **Website**, **Gateway**, **Doorlock**, dan **Firebase** pakai nama & nilai yang sama persis. Pendamping [Git Dictionary](Git%20Dictionary.md): kalau Git Dictionary ngatur cara nulis commit, dokumen ini ngatur cara nulis nama.

Aturannya simpel: **kalau nambah field/konstanta/kode pesan baru, daftarin dulu di sini**, baru dipakai di kode. Kalau ada nama yang dipakai di dua tempat (misal website & firmware), nilainya wajib sama dan ditandai ⇄ di tabel.

## 1. Aturan Penamaan

### Gaya Penulisan

| Jenis | Gaya | Contoh |
|-------|------|--------|
| Field Firebase | `camelCase` | `rfidAccess`, `doorlockMac`, `connectionReason` |
| Nilai enum (string) di Firebase | huruf kecil, `snake_case` kalau lebih dari 1 kata | `locked`, `disconnected`, `rfid_block` |
| Variabel & fungsi (JS dan C++) | `camelCase` | `gatewayPath`, `refreshRooms()`, `logHistory()` |
| Konstanta (`const` JS, `#define` C++) | `UPPER_SNAKE_CASE` | `MAX_ROOMS`, `HEARTBEAT_TIMEOUT_MS` |
| Tipe/struct C++ | `PascalCase` | `Room`, `DoorMessage`, `DoorStatusMessage` |
| Kode pesan ESP-NOW | `CMD_` (gateway → doorlock), `EVT_` (doorlock → gateway) | `CMD_UNLOCK`, `EVT_HEARTBEAT` |
| Perintah Serial Monitor | huruf kecil, argumen dipisah spasi | `battery 101 75`, `rfid 101 block` |

### Akhiran (Suffix) Wajib

| Akhiran | Arti | Contoh |
|---------|------|--------|
| `…At` | Waktu kejadian, **epoch milidetik** (sebisa mungkin server timestamp Firebase `{".sv": "timestamp"}`) | `unlockedAt`, `pairedAt`, `lastSeen`* |
| `…_MS` | Durasi dalam milidetik | `HEARTBEAT_INTERVAL_MS`, `GATEWAY_OFFLINE_MS` |
| `…_SECONDS` / `…Seconds` | Durasi dalam detik | `AUTO_LOCK_SECONDS`, `lastDisconnectSeconds` |
| `…Mac` | MAC address, format di bawah | `gatewayMac`, `doorlockMac` |
| `MAX_…` | Batas jumlah | `MAX_ROOMS`, `MAX_HISTORY_PER_ROOM` |

\* `lastSeen` pengecualian yang udah terlanjur dipakai; field waktu baru tetap pakai `…At`.

### Format Nilai

| Data | Format | Contoh |
|------|--------|--------|
| MAC address | 6 byte heksadesimal **huruf besar**, dipisah `:` | `80:45:6B:18:8F:A4` |
| Baterai | Bilangan bulat 0–100 (%) | `75` |
| Waktu | Epoch milidetik (UTC) | `1790505928445` |
| Key kamar | `Kamar {nomor}` | `Kamar 101` |
| Nomor kamar | Angka lantai × 100 + urutan (1–20) | Lantai 2 → `201`–`220` |
| Key lantai | `Lantai {n}` (dipilih dari dropdown) | `Lantai 1` |
| Key cabang | `{nama} - {alamat}`, disanitasi, maks 60 karakter | `ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja` |
| Key gateway | Nama yang diketik admin, disanitasi | `Gateway 2` |

Key Firebase nggak boleh berisi `. # $ [ ] /` (dibuang oleh `sanitizeKeyPart()` di website). Key **boleh** berisi spasi & koma, jadi firmware wajib nge-encode path sebelum request (`dbPath()`).

## 2. Struktur Firebase Realtime Database

```
users/{uid}
meta/userCounter
pendingGateways/{macGateway}
pendingDevices/{macDoorlock}
locations/{cabang}
  name, address
  {lantai}
    createdAt                      (placeholder lantai kosong)
    {gateway}
      gatewayMac, createdAt
      gatewayStatus
      Kamar {n}
```

### `users/{uid}`

| Field | Tipe | Nilai | Ditulis oleh |
|-------|------|-------|--------------|
| `email` | string | email login (username tanpa `@` jadi `{username}@isk-house.local`) | Website |
| `label` | string | nama tampilan otomatis dari `meta/userCounter` | Website |
| `role` | string | `admin` / `user` | Website (admin) |
| `status` | string | `pending` / `approved` / `rejected` | Website (admin) |
| `createdAt` | number | epoch ms | Website |

### `pendingGateways/{macGateway}` dan `pendingDevices/{macDoorlock}`

| Node | Field | Tipe | Ditulis oleh | Dihapus oleh |
|------|-------|------|--------------|--------------|
| `pendingGateways/{mac}` | `pairedAt` | number (server timestamp) | Gateway, saat belum punya node di `locations` | Website, setelah gateway diklasifikasikan |
| `pendingDevices/{mac}` | `gatewayMac` | string (MAC) | Gateway, setelah doorlock lolos pairing HMAC | Website, setelah doorlock diklasifikasikan |
| | `pairedAt` | number (server timestamp) | Gateway | |

### Node Gateway: `locations/{cabang}/{lantai}/{gateway}`

| Field | Tipe | Nilai / Keterangan | Ditulis oleh |
|-------|------|--------------------|--------------|
| `gatewayMac` | string (MAC) | Kunci pencarian: gateway nyari node dengan `gatewayMac` = MAC-nya | Website (klasifikasi) |
| `createdAt` | number | Placeholder supaya gateway kosong nggak dipangkas Firebase | Website |
| `gatewayStatus/lastSeen` | number (server timestamp) | Diperbarui tiap `GATEWAY_HEARTBEAT_MS` | Gateway |
| `gatewayStatus/lastRestartReason` | string | Teks dari `esp_reset_reason()` | Gateway |
| `gatewayStatus/lastRestartAt` | number | | Gateway |
| `gatewayStatus/lastDisconnectReason` | string | Teks dari alasan putus WiFi | Gateway |
| `gatewayStatus/lastDisconnectSeconds` | number | Lama terputus (detik) | Gateway |
| `gatewayStatus/lastReconnectAt` | number | | Gateway |

Field metadata gateway (**bukan** kamar) wajib didaftarkan di `GATEWAY_META_FIELDS` (website) dan dilewati di `refreshRooms()` (firmware). Isi sekarang: `gatewayMac`, `createdAt`, `gatewayStatus`.

### Node Kamar: `…/{gateway}/Kamar {n}`

| Field | Tipe | Nilai | Ditulis oleh |
|-------|------|-------|--------------|
| `tenant` | string | nama penghuni, `""` = kosong | Website |
| `status` | string | `locked` / `unlocked` | Website, Gateway |
| `unlockedAt` | number | waktu dibuka; dihapus saat `locked` | Website, Gateway |
| `rfidAccess` | boolean | `true` = kartu diizinkan, `false` = diblokir | Website, Gateway |
| `doorlockMac` | string (MAC) | doorlock yang terpasang, dari klasifikasi | Website |
| `battery` | number | 0–100 | Gateway |
| `connection` | string | `connected` / `disconnected` | Gateway |
| `connectionReason` | string | penyebab, lihat [bagian 5](#5-teks-penyebab-status) | Gateway |
| `connectionUpdatedAt` | number (server timestamp) | | Gateway |

`battery`, `connection`, `connectionReason`, `connectionUpdatedAt` = `DEVICE_STATUS_FIELDS` di website; wajib dipertahankan waktu kamar diedit.

`history` **tidak** lagi disimpan di Firebase (lihat bagian 3).

## 3. Riwayat di `localStorage` Browser

Key: `isk-history` (`HISTORY_STORAGE_KEY`), isi array entri:

| Field | Tipe | Nilai |
|-------|------|-------|
| `loc`, `floor`, `gw` | string | key cabang / lantai / gateway |
| `roomNumber` | number | `101` |
| `action` | string | lihat tabel di bawah |
| `by` | string | label user, atau `Sistem (Auto-kunci)` |
| `timestamp` | number | epoch ms |

| `action` | Arti |
|----------|------|
| `unlock` | Pintu dibuka |
| `lock` | Pintu dikunci |
| `rfid_block` | Kartu RFID diblokir |
| `rfid_unblock` | Kartu RFID diizinkan lagi |
| `classified` | Doorlock diklasifikasikan ke kamar |

## 4. Pesan ESP-NOW

Jenis pesan dibedakan dari **panjang + byte pertama**, jadi panjang tiap jenis nggak boleh sama.

| Pesan | Panjang | Arah | Isi |
|-------|---------|------|-----|
| `TAG` | 4 byte | Doorlock → broadcast | `{kode kos, jenis perangkat, versi HW, versi SW}`, sekarang `00 00 00 00` |
| `AuthMessage` | 8 byte | dua arah | `uint32_t nonce` + `uint8_t proof[3]` (HMAC-SHA256 dipotong 3 byte, lihat [HMAC](HMAC.md)) |
| `DoorMessage` | 2 byte | dua arah | `header = 0xD0` (`DOOR_MSG_HEADER`) + `code` |
| `DoorStatusMessage` | 3 byte | Doorlock → Gateway | `header = 0xD1` (`DOOR_STATUS_HEADER`) + `battery` (0–100) + `unlocked` (1/0) |

### Kode `DoorMessage`

| Kode | Nama | Arah | Arti |
|------|------|------|------|
| `0x01` | `CMD_LOCK` | Gateway → Doorlock | Kunci pintu |
| `0x02` | `CMD_UNLOCK` | Gateway → Doorlock | Buka pintu |
| `0x03` | `CMD_RFID_ALLOW` | Gateway → Doorlock | Izinkan kartu RFID |
| `0x04` | `CMD_RFID_BLOCK` | Gateway → Doorlock | Blokir kartu RFID |
| `0x11` | `EVT_LOCKED` | Doorlock → Gateway | Pintu terkunci |
| `0x12` | `EVT_UNLOCKED` | Doorlock → Gateway | Pintu terbuka |
| `0x13` | `EVT_BATTERY_SHUTDOWN` | Doorlock → Gateway | Pamit mati karena baterai habis |
| `0xF0`–`0xF2` | `EVT_PAIRED`, `EVT_REJECTED`, `EVT_HEARTBEAT` | internal Gateway | Antrian dari callback ESP-NOW ke `loop()`, **tidak** dikirim lewat radio |

Rentang kode: `0x0_` perintah, `0x1_` kejadian dari doorlock, `0xF_` internal. Kode baru ikut rentang ini.

## 5. Teks Penyebab Status

Teks ini ditampilkan apa adanya di website, jadi ditulis dalam Bahasa Indonesia yang bisa dibaca penghuni/admin.

| Field | Teks | Kapan |
|-------|------|-------|
| `connectionReason` | `Doorlock tersambung ke gateway` | Heartbeat datang lagi |
| | `Baterai doorlock habis (terakhir X%)` | Terputus dengan baterai terakhir ≤ `BATTERY_EMPTY` |
| | `Baterai doorlock habis (0%), doorlock mati` / `Baterai doorlock habis, doorlock mati` | Baterai 0 / `EVT_BATTERY_SHUTDOWN` |
| | `Sinyal terputus, doorlock di luar jangkauan gateway atau ada gangguan jaringan` | Terputus selain karena baterai |
| | `Simulasi doorlock dihentikan` | Perintah `sim … stop` |
| `lastRestartReason` | `Gateway dinyalakan (listrik sempat mati atau kabel dicabut)`, `Tegangan listrik gateway turun (brownout)`, `Gateway restart karena error program`, `Gateway di-restart oleh program`, `Gateway di-reset lewat tombol reset`, `Gateway dinyalakan ulang (reset lewat USB / upload program)` | Dari `esp_reset_reason()` |
| `lastDisconnectReason` | `WiFi tidak ditemukan (…)`, `Sinyal WiFi hilang (…)`, `Password WiFi ditolak router`, `Koneksi WiFi terputus (kode N)` | Dari alasan putus WiFi |

## 6. Konstanta Bersama

⇄ = dipakai di website **dan** firmware; kalau diubah, ubah di dua-duanya.

| Konstanta | Nilai | Website | Gateway | Keterangan |
|-----------|-------|:-------:|:-------:|------------|
| `MAX_ROOMS` ⇄ | 20 | ✓ | ✓ | Kamar per gateway |
| `BATTERY_LOW` ⇄ | 20 (%) | ✓ | ✓ | Batas baterai lemah (merah di website, notifikasi di gateway) |
| `BATTERY_EMPTY` | 5 (%) | | ✓ | Di bawah ini, terputus dianggap karena baterai |
| `GATEWAY_HEARTBEAT_MS` / `GATEWAY_OFFLINE_MS` ⇄ | 30000 / 75000 | ✓ (offline) | ✓ (heartbeat) | Offline harus > 2× heartbeat |
| `HEARTBEAT_INTERVAL_MS` | 5000 | | ✓ | Doorlock kirim `DoorStatusMessage` (wajib sama di firmware Doorlock nanti) |
| `HEARTBEAT_TIMEOUT_MS` | 15000 | | ✓ | 3× heartbeat hilang = terputus |
| `AUTO_LOCK_SECONDS` / `SIM_AUTO_LOCK_MS` ⇄ | 5 detik | ✓ | ✓ | Pintu terkunci otomatis setelah dibuka |
| `MAX_HISTORY_PER_ROOM` | 1000 | ✓ | | Riwayat per kamar di `localStorage` |
| `MAX_FLOORS` | 20 | ✓ | | Pilihan "Lantai N" |
| `DISCOVERY_RETRY_MS` | 15000 | | ✓ | Cek ulang klasifikasi gateway |
| `PAIRING_WINDOW_MS` | 60000 | | ✓ | Lama mode pairing |
| `CHALLENGE_TIMEOUT` | 2000 (ms) | | ✓ | Batas tunggu balasan HMAC |
| `DUMMY_ROOMS` | `"*"` | | ✓ | Kamar yang dapat doorlock dummy |

## 7. Perintah Serial Gateway

Ketik `help` di Serial Monitor. `{n}` = nomor kamar, `{mac}` = MAC doorlock.

| Perintah | Fungsi |
|----------|--------|
| `help`, `rooms`, `Pairing`, `reset` | Umum |
| `unlock {n}`, `lock {n}` | Ubah `status` kamar |
| `rfid {n} block`, `rfid {n} allow` | Ubah `rfidAccess` |
| `sim {n}`, `sim {n} stop`, `battery {n} {0-100}`, `signal {n} on\|off`, `tap {n}` | Simulasi doorlock |
| `pair {mac}`, `unlock {mac}`, `lock {mac}` | Simulasi pesan dari doorlock asli |

## 8. Nama yang Belum Seragam

Udah terlanjur dipakai dan belum diubah. Jangan ditiru buat nama baru; kalau suatu saat diseragamkan, ubah di semua tempat sekaligus.

| Sekarang | Masalah | Seharusnya |
|----------|---------|------------|
| `AUTO_LOCK_SECONDS` (website) vs `SIM_AUTO_LOCK_MS` (gateway) | Satuan beda untuk nilai yang sama | `AUTO_LOCK_MS` di dua-duanya |
| `CHALLENGE_TIMEOUT` | Nggak ada satuan | `CHALLENGE_TIMEOUT_MS` |
| `lastSeen` | Nggak pakai akhiran `…At` | `lastSeenAt` |
| `rfid_unblock` (riwayat) vs `allow` / `CMD_RFID_ALLOW` | Dua kata untuk hal yang sama | Pilih satu: `allow` |
| `status` di `users` vs `status` di kamar | Nama sama, arti beda | Dibiarkan (beda node), tapi field baru jangan dinamai `status` lagi |

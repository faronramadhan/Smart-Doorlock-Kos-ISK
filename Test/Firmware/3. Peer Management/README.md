# Peer Management

Lanjutan dari percobaan [Autentikasi HMAC](../2.%20Autentikasi%20HMAC/), tapi sekarang fokusnya bukan lagi di cara membuktikan keaslian device (itu udah beres), melainkan di cara **mengelola** hasil autentikasi itu supaya bisa dipakai di produk sungguhan: gimana caranya beberapa Doorlock bisa antre dan diverifikasi satu-satu dalam satu sesi pairing, gimana caranya hasil bonding tetap ada walau device restart, dan gimana caranya device yang udah bonded bisa saling memutus koneksi secara sengaja.

## Perangkat

| Perangkat  | Board | Port |
|------------|-------|------|
| Doorlock 1 | DFRobot Beetle ESP32-C3 | COM29 |
| Doorlock 2 | DFRobot Beetle ESP32-C3 | COM30 |
| Doorlock 3 | DFRobot Beetle ESP32-C3 | COM31 |
| Gateway    | DFRobot Beetle ESP32-C3 | COM28 |

## Kenapa Test 2 Belum Cukup

Firmware di Test 2 udah bisa membuktikan bahwa Doorlock yang connect itu benar-benar tahu `SECRET_KEY` yang sama (lewat HMAC-SHA256 challenge-response), tapi begitu proses itu selesai:

1. **Bonding-nya hilang kalau device di-restart.** `esp_now_add_peer()` cuma nyimpen peer di RAM. Reboot Gateway = semua Doorlock yang udah pernah lolos verifikasi harus authenticate ulang dari nol.
2. **Cuma bisa nerima 1 kandidat per sesi pairing.** Kalau ada 2 Doorlock nyala bareng dan masuk mode pairing bersamaan, `queueCount` di Test 2 emang udah nampung lebih dari satu MAC ke antrian, tapi begitu kandidat pertama diproses (lolos atau gagal), Gateway nggak ngelanjutin ke kandidat kedua — device dianggap selesai satu sesi.
3. **Nggak ada cara buat "melepas" pairing dengan sengaja.** Begitu Doorlock ke-bonding, satu-satunya cara ngilanginnya adalah reset firmware/flash ulang.
4. **Nggak ada visibilitas.** Nggak ada cara buat nanya ke Gateway "lu lagi kebonding ke berapa Doorlock, MAC-nya apa aja."

Test 3 nutup keempat gap ini tanpa mengubah cara autentikasinya sama sekali — HMAC challenge-response dari Test 2 dipakai apa adanya.

## Teori

### NVS lewat Preferences

ESP32 punya partisi flash khusus bernama NVS (**N**on-**V**olatile **S**torage) yang isinya tetap ada walau power mati — beda sama RAM yang kosong lagi tiap reboot. Library `Preferences.h` adalah pembungkus sederhana di atas NVS, dipakai dengan pola key-value:

```cpp
prefs.begin("gateway", false);   // buka "namespace" bernama "gateway", false = mode baca-tulis
prefs.putUChar("count", peerCount);
prefs.putBytes("macs", peers, peerCount * 6);
```

`namespace` (parameter pertama `begin()`) itu kayak folder — Gateway dan Doorlock pakai namespace berbeda (`"gateway"` vs `"doorlock"`) di flash yang sama, jadi datanya nggak akan pernah ketimpa satu sama lain. `putBytes`/`getBytes` dipakai buat nyimpen array MAC address mentah (blob biner), sementara `putUChar`/`getUChar` buat angka kecil (jumlah peer).

Konsekuensi penting: nulis ke NVS itu **lambat** dibanding operasi RAM biasa (butuh siklus erase-write ke flash), jadi `savePeers()` sengaja dipanggil cuma di titik-titik penting (abis bonding baru, abis disconnect, abis reset) — bukan tiap loop.

### Antrian (Queue) untuk Multi-Kandidat

Alih-alih Gateway langsung tantang (challenge) device pertama yang kedengeran, semua kandidat yang broadcast `TAG` selagi `listening` aktif masuk dulu ke antrian:

```cpp
uint8_t queueMac[MAX_QUEUE][6];
int queueCount = 0;
```

Ini array sederhana yang dipakai sebagai FIFO (First In, First Out) manual: kandidat baru ditambahkan di ujung (`queueMac[queueCount]`), dan waktu diproses, elemen pertama diambil lalu semua elemen sisanya digeser satu langkah ke depan:

```cpp
memcpy(currentMac, queueMac[0], 6);
for (int i = 1; i < queueCount; i++) {
  memcpy(queueMac[i - 1], queueMac[i], 6);
}
queueCount--;
```

Gateway cuma nantang **satu kandidat dalam satu waktu** (`awaitingResponse`) — bukan karena keterbatasan hardware, tapi karena tiap challenge butuh nonce unik dan Gateway harus tahu persis siapa yang lagi ditunggu balasannya. Begitu kandidat itu selesai diproses (lolos, ditolak, atau timeout), Gateway otomatis lanjut ke kandidat berikutnya di antrian selama masih dalam mode `listening`. Efeknya: berapa pun Doorlock yang nyalain mode pairing bersamaan, semuanya bakal dicoba satu-satu tanpa perlu trigger `Pairing` ulang di Gateway.

### Idle Timeout, Bukan Timeout Tetap

`PAIRING_TIMEOUT` (60 detik) bukan dihitung dari kapan `listening` pertama kali diaktifkan, tapi di-reset ulang tiap kali ada aktivitas protokol:

```cpp
listenStartedAt = millis();
```

Baris ini muncul di tiga tempat: waktu kandidat baru masuk antrian, dan waktu satu kandidat selesai diproses (baik lolos maupun ditolak) — baik di `onReceive()` maupun waktu `CHALLENGE_TIMEOUT` kena. Efeknya, window pairing otomatis "molor" selama Gateway masih sibuk kerja. Window itu cuma bener-bener tertutup kalau 60 detik berlalu **tanpa ada aktivitas apapun** — entah karena dari awal emang nggak ada Doorlock yang kedengeran, atau karena semua kandidat di antrian udah habis dicoba dan gagal semua.

### Sinyal Disconnect Satu Arah

Selain challenge (7 byte) dan tag broadcast (4 byte), ada satu jenis pesan lagi: sinyal disconnect, cuma 1 byte:

```cpp
#define MSG_DISCONNECT 2
```

Doorlock kirim byte ini ke Gateway waktu user ngetik `Pairing` padahal device udah `paired` — device otomatis putus dulu dari Gateway lama sebelum mulai broadcast buat pairing baru. Ukuran payload (1 byte) sengaja beda jauh dari kedua jenis pesan lain (4 byte buat tag, 7 byte buat `AuthMessage`), jadi Gateway bisa langsung tahu jenis pesan apa yang masuk cuma dari `len`-nya, tanpa butuh header/tipe pesan terpisah:

```cpp
if (len == 1 && data[0] == MSG_DISCONNECT) { removePeer(mac); return; }
if (len == 4 && memcmp(data, TAG, 4) == 0)  { /* kandidat baru */ }
if (len == sizeof(AuthMessage))             { /* balasan challenge */ }
```

Penting: penanganan `MSG_DISCONNECT` diletakkan **di luar** guard `if (!listening) return;` — beda dari dua jenis pesan lain yang cuma diproses kalau Gateway lagi dalam mode listen. Disconnect harus selalu bisa diproses kapan pun, soalnya device yang mau putus koneksi nggak nunggu Gateway masuk mode pairing dulu.

## Library

| Library | Fungsi |
|---------|--------|
| `Preferences.h` | Akses NVS (flash non-volatile) lewat API key-value — dipakai buat nyimpen daftar peer (Gateway) dan status pairing (Doorlock) supaya tetap ada walau device restart. |
| `mbedtls/md.h` | Sama seperti Test 2 — HMAC-SHA256 buat proof-of-possession `SECRET_KEY`. |
| `esp_system.h` | Nyediain `esp_random()`, dipakai Gateway buat generate nonce acak tiap challenge. |

## Program

### Gateway.cpp — Struktur Data

```cpp
uint8_t queueMac[MAX_QUEUE][6];   // antrian kandidat yang nunggu ditantang
int queueCount = 0;

uint8_t currentMac[6];            // kandidat yang lagi diproses sekarang
uint32_t currentNonce = 0;
bool awaitingResponse = false;

int peerCount = 0;
uint8_t peers[MAX_PEERS][6];      // daftar peer yang udah lolos verifikasi (persisten)
```

Ada dua "daftar" MAC address yang perlu dibedakan: `queueMac` isinya kandidat yang **belum** terverifikasi (cuma ketahuan broadcast tag doang), sedangkan `peers` isinya device yang **udah** lolos HMAC dan di-bonding permanen. Kandidat pindah dari satu ke yang lain hanya lewat jalur `onReceive()` yang berhasil verifikasi proof-nya.

### Gateway.cpp — Alur Bonding

```cpp
if (len == sizeof(AuthMessage) && awaitingResponse && memcmp(mac, currentMac, 6) == 0) {
  const AuthMessage *reply = (const AuthMessage*)data;
  if (reply->nonce != currentNonce) return;

  uint8_t expectedProof[3];
  computeProof(currentNonce, expectedProof);

  if (memcmp(reply->proof, expectedProof, 3) == 0) {
    memcpy(peers[peerCount], currentMac, 6);
    peerCount++;
    savePeers();
    ...
  } else {
    esp_now_del_peer(currentMac);
    ...
  }

  awaitingResponse = false;
  listenStartedAt = millis();
}
```

`esp_now_add_peer()` buat kandidat itu sendiri udah dipanggil lebih dulu, sebelum challenge dikirim (soalnya `esp_now_send()` butuh alamat tujuan terdaftar sebagai peer dulu, apapun hasil verifikasinya nanti). Kalau proof valid, kandidat itu **tetap** jadi peer ESP-NOW (nggak didaftarkan ulang) — yang terjadi cuma nyalin MAC-nya ke `peers[]` dan nulis ke NVS supaya persisten. Kalau tidak valid, peer yang tadi didaftarkan sementara langsung dihapus lagi lewat `esp_now_del_peer()`, jadi nggak nyangkut nyampah di tabel peer ESP-NOW.

### Gateway.cpp — Command Serial

| Command | Efek |
|---------|------|
| `Pairing` | Masuk mode `listening`, reset antrian dan window timeout. Diabaikan kalau udah dalam mode listening. |
| `Reset` | Hapus **semua** peer yang ke-bonding (`esp_now_del_peer` tiap satu + flush NVS jadi kosong). |
| `Status` | Cetak jumlah peer aktif dan daftar MAC address-nya, dibaca langsung dari `peers[]`. |

### Doorlock.cpp — Bonding Otomatis Saat Pairing

```cpp
void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (!broadcasting || len != sizeof(AuthMessage)) return;
  ...
  broadcasting = false;
  paired = true;
  memcpy(gatewayMac, mac, 6);
  savePairing();
  ...
}
```

Beda dari Gateway, Doorlock **tidak menunggu konfirmasi akhir** apakah Gateway menerima proof-nya atau tidak — begitu challenge diterima dan response terkirim, Doorlock langsung anggap dirinya `paired` dan simpan MAC Gateway ke NVS. Ini valid selama Doorlock memang device asli yang tahu `SECRET_KEY` yang benar (proof-nya pasti akan diterima Gateway); device palsu yang nggak tahu key-nya nggak akan pernah sampai ke titik ini karena nggak akan pernah dapat challenge (dia nggak pernah membuktikan diri di RF layer lebih dulu — tapi kalaupun dapat challenge dari trik apapun, dia tetap nggak akan bisa hitung proof yang benar).

### Doorlock.cpp — Reconnect Otomatis Lewat Command yang Sama

```cpp
if (command == "Pairing" && !broadcasting) {
  if (paired) disconnectFromGateway();

  broadcasting = true;
  broadcastStartedAt = millis();
  ...
}
```

Nggak ada command `Reset` terpisah di Doorlock. Command `Pairing` yang sama dipakai baik buat pairing pertama kali maupun buat pindah ke Gateway lain — kalau device kedapatan lagi `paired`, dia otomatis kirim `MSG_DISCONNECT` ke Gateway lama dan hapus data pairing lokal dulu, baru mulai proses broadcast tag yang baru.

## Test Procedure

1. Upload `Doorlock.cpp` ke ketiga board Doorlock (COM29, COM30, COM31) dan `Gateway.cpp` ke board Gateway (COM28), lewat project PlatformIO di `Firmware/`.
2. Buka empat serial monitor terpisah (satu per board), ketik `Pairing` di salah satu Doorlock dan di Gateway (Newline sebagai line ending).
3. Doorlock bakal broadcast tag, Gateway bakal:
   - Cetak `Kandidat terdeteksi: ..., masuk antrian.`
   - Cetak `Challenge dikirim ke ... (nonce=0x...).`
   - Cetak `Valid, bonding permanen: ... (1/20)`
4. Ketik `Status` di Gateway — pastikan MAC Doorlock muncul di daftar.
5. **Uji persistensi**: tekan tombol reset fisik di Gateway (jangan cabut kabel, cukup reset). Ketik `Status` lagi setelah boot ulang — MAC yang sama harus tetap muncul tanpa perlu pairing ulang.
6. **Uji multi-device**: ketik `Pairing` di ketiga Doorlock (COM29, COM30, COM31), lalu `Pairing` sekali saja di Gateway. Ketiganya harus ke-bonding berurutan dalam satu sesi listen yang sama — cek `Status` sampai muncul `3/20`.
7. **Uji disconnect**: ketik `Pairing` lagi di salah satu Doorlock yang udah `paired`. Doorlock akan cetak `Terputus dari Gateway lama.`, dan Gateway akan cetak `Peer terputus: ...` tanpa perlu command apapun di sisi Gateway.
8. **Uji reset massal**: ketik `Reset` di Gateway — semua peer harus hilang dari `Status`, dan tetap kosong walau Gateway di-reset fisik.

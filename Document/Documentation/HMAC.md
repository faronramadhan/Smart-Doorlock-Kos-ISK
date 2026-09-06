# HMAC — Autentikasi Pairing Doorlock & Gateway

Dokumen ini menjelaskan dasar teori HMAC (Hash-based Message Authentication Code) dan penerapannya pada proses pairing Doorlock–Gateway lewat ESP-NOW. Ditulis agar dapat dipahami tanpa latar belakang kriptografi sebelumnya.

> **Catatan istilah:** "MAC" dipakai untuk dua hal berbeda pada dokumen ini — **MAC address** (alamat radio, contoh `80:45:6B:18:82:28`, dibahas di [README Test 1](../../Test/1.%20Broadcast%20MAC%20Address/README.md)) dan **MAC (Message Authentication Code)**, istilah kriptografi hasil HMAC. Kapan pun "MAC" muncul tanpa kata "address", yang dimaksud adalah Message Authentication Code.

## 1. Kenapa Dibutuhkan

ESP-NOW bersifat broadcast terbuka — paket yang dikirim satu perangkat dapat didengar perangkat lain mana pun di channel yang sama, termasuk yang tidak dituju. Pada [Test 1](../../Test/1.%20Broadcast%20MAC%20Address/README.md), Gateway langsung mempercayai MAC pertama yang mengirim broadcast, tanpa cara membuktikan itu Doorlock yang sah. HMAC menutup celah ini: Doorlock dapat membuktikan mengetahui suatu kata sandi rahasia, tanpa pernah mengucapkannya di ruang terbuka.

## 2. Konsep Dasar

### 2.1 Fungsi Hash

Fungsi hash mengubah data berapa pun panjangnya menjadi "sidik jari" dengan panjang tetap. Proyek ini memakai **SHA-256** (sidik jari 32 byte), tersedia bawaan di ESP32 lewat `mbedtls`. Tiga sifatnya: **deterministik** (input sama, hasil sama), **satu arah** (sidik jari tidak bisa ditelusuri balik ke data aslinya), dan **perubahan kecil menghasilkan hasil yang berubah total**. Pembuktian sifat ketiga, dihitung langsung dan dapat direproduksi (`python3 -c "import hashlib; print(hashlib.sha256(b'UNLOCK').hexdigest())"`):

```
SHA256("UNLOCK") = 09911d6fa2916d46612523684bb34dd785ee323c2a1890ccab0df00a1c4387fa
SHA256("UNLOCM") = a5599de7e4bcbf7e31a8549ca1637618e4f7370c4192af95adc20ac4fddca5e9
```

Beda satu huruf, hasil berubah total — inilah yang membuat hash tidak membocorkan petunjuk apa pun tentang isi aslinya.

### 2.2 HMAC — Hash dan Kata Sandi Rahasia

Sidik jari saja belum cukup untuk membuktikan identitas, karena siapa pun bisa menghitungnya tanpa mengetahui rahasia apa pun. HMAC menggabungkan hash dengan **kata sandi rahasia**, sehingga hasil yang identik hanya bisa dihasilkan oleh pihak yang mengetahui kata sandi tersebut — analog dengan satpam yang meminta "hasil perhitungan dari tanggal lahir istri Anda, bukan tanggal lahirnya langsung", sehingga penguping hanya mendengar hasil hitungannya, bukan data aslinya.

<details>
<summary>Rumus formal (opsional)</summary>

```
HMAC(K, m) = H( (K' XOR opad) || H( (K' XOR ipad) || m ) )
```

`K` = kata sandi, `m` = pesan, `H` = SHA-256, `K'` = kata sandi yang disesuaikan panjangnya, `ipad`/`opad` = dua pola byte tetap yang berbeda. Hash dilakukan dua kali (bukan `H(K||m)` sekali) untuk menutup celah *length extension attack* yang dimiliki SHA-256 bila dipakai satu lapis saja.

</details>

Diimplementasikan lewat fungsi bawaan, tanpa perlu menyusun langkah-langkah di atas secara manual:

```cpp
#include <mbedtls/md.h>

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3); // lihat 2.4 soal pemotongan jadi 3 byte
}
```

### 2.3 Nonce — Angka Acak agar Tidak Bisa Diputar Ulang

HMAC bersifat deterministik, sehingga `HMAC(kata sandi, "pesan tetap")` selalu sama. Bila dikirim apa adanya, penyadap dapat memutar ulang (*replay*) nilai itu tanpa pernah mengetahui kata sandinya. Solusinya: setiap sesi menyertakan **nonce**, angka acak yang berbeda-beda, sehingga hasilnya ikut berubah tiap sesi:

```
nonce = 0x12345678  ->  proof (3 byte) = 6D:06:43
nonce = 0x12345679  ->  proof (3 byte) = 07:E0:1C
```

Nonce dibangkitkan lewat `esp_random()` — Random Number Generator berbasis hardware ESP32 (derau elektronik radio), bukan rumus berpola yang bisa ditebak.

### 2.4 Truncation — Memotong Hasil Jadi 3 Byte

HMAC-SHA256 menghasilkan 32 byte penuh; proyek ini hanya memakai **3 byte pertama** agar formatnya konsisten dengan gaya MAC address (`XX:XX:XX`). Praktik memotong MAC ini lazim dipakai (WPA2 CCMP: 8 byte, Bluetooth LE: 4 byte, dari total 32 byte). Konsekuensinya, peluang tebakan acak kebetulan benar adalah 1 berbanding ±16,7 juta (2²⁴) — dapat diterima karena dikombinasikan dengan batas waktu tantangan (bagian 3.3).

## 3. Protokol yang Diterapkan

### 3.1 Tag Identifikasi

Sebelum menantang perangkat mana pun, Gateway menyaring dulu siapa yang layak ditantang, lewat tag 4 byte yang di-broadcast Doorlock — **tidak rahasia**, sekadar penanda "perangkat ini bagian dari ekosistem ISK":

```cpp
const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 };
// byte 1: kode kos (Kos ISK = 0x00)
// byte 2: jenis perangkat (Doorlock = 0x00)
// byte 3: versi hardware
// byte 4: versi software
```

Format ini bersifat rancangan awal — klasifikasi jenis dan versi perangkat yang lebih lengkap direncanakan dikelola lewat basis data terpisah di kemudian hari, di luar cakupan dokumen ini.

### 3.2 Alur Pairing

```
Doorlock                                        Gateway
   |--- broadcast TAG (4 byte) ------------------->|  (cek TAG cocok -> masuk antrian)
   |                                                |  (antrian diproses satu per satu)
   |<-------------- AuthMessage{nonce} -------------|
   | proof = HMAC(SECRET_KEY, nonce)[:3]            |
   |--------- AuthMessage{nonce, proof} ----------->|  (cek MAC pengirim + proof cocok)
   |                                                |
   |                                    [cocok] -> peer didaftarkan
   |                                    [gagal/timeout] -> peer dibuang, lanjut antrian berikutnya
```

Format pesan setelah tahap TAG:

```cpp
typedef struct {
  uint32_t nonce;    // diisi Gateway
  uint8_t proof[3];  // diisi Doorlock
} AuthMessage;
```

Gateway memproses kandidat **satu per satu**, bukan sekaligus — begitu satu kandidat selesai (valid, ditolak, atau timeout), baru kandidat berikutnya di antrian ditantang. Pendekatan ini dipilih karena jauh lebih sederhana untuk diimplementasikan dibanding menantang banyak kandidat secara paralel, dengan konsekuensi waktu pairing bertambah sebanding jumlah kandidat dalam antrian — dapat diterima karena pairing hanya terjadi saat pemasangan, bukan operasi rutin harian.

### 3.3 Contoh Perhitungan Nyata

Doorlock kamar 1, MAC `80:45:6B:18:82:28`, kata sandi `"ISK-Doorlock-Kamar01"`:

1. Doorlock broadcast TAG.
2. Gateway mengenali TAG, mengantre MAC tersebut, lalu (saat gilirannya) membangkitkan nonce `0x12345678` dan mengirimkannya sebagai `78 56 34 12` (4 byte, urutan *little-endian*).
3. Doorlock menghitung `HMAC-SHA256("ISK-Doorlock-Kamar01", 78 56 34 12)`, mengambil 3 byte pertama: `6D:06:43`, mengirimkannya kembali.
4. Gateway menghitung ulang secara independen, mendapat `6D:06:43` yang identik → peer didaftarkan.

Nilai `78 56 34 12` dan `6D:06:43` boleh diketahui siapa pun yang menyadap — keduanya tidak membocorkan kata sandi sedikit pun.

### 3.4 Referensi Kode

Diterapkan pada [Firmware/Doorlock/src/main.cpp](../../Firmware/Doorlock/src/main.cpp) dan [Firmware/Gateway/src/main.cpp](../../Firmware/Gateway/src/main.cpp), disalin sebagai snapshot pengujian pada [Test/2. Autentikasi HMAC](../../Test/2.%20Autentikasi%20HMAC/). Kata sandi yang dipakai saat ini (`SECRET_KEY`) masih seragam untuk seluruh Doorlock — lihat bagian 4 soal risikonya pada skala produksi.

## 4. Manajemen Kunci untuk Banyak Unit Doorlock

Membedakan unit Doorlock sudah terselesaikan secara alami lewat MAC address unik bawaan chip — tidak perlu mekanisme tambahan. Yang jadi keputusan desain terpisah adalah **kata sandi HMAC**:

- **Kata sandi seragam untuk semua unit** (dipakai saat ini) — sederhana, tetapi satu unit yang dibongkar fisik membocorkan akses ke seluruh unit lain yang memakai kata sandi sama.
- **Kata sandi turunan per unit** (direkomendasikan untuk produksi) — dihitung dari satu kata sandi induk yang hanya disimpan di Gateway/server produksi, memakai MAC address unit itu sendiri sebagai pembeda:

  ```
  kunci_doorlock = HMAC(kunci_induk, MAC_doorlock)
  ```

  Hanya hasil akhirnya (`kunci_doorlock`) yang ditanam ke tiap unit lewat penyimpanan NVS saat produksi — **kunci induk tidak pernah disimpan di Doorlock manapun**. Jika satu unit bocor, unit lain tetap aman, karena HMAC tidak bisa dibalik untuk menemukan kunci induk. Firmware yang di-upload tetap identik untuk seluruh unit; hanya kunci hasil turunan yang berbeda per unit dan ditulis terpisah ke NVS, sehingga tidak perlu kompilasi ulang per perangkat.

## 5. Keterbatasan yang Diketahui: Serangan Relay

Skema di atas tetap rentan terhadap **serangan relay**: penyerang meneruskan nonce dan proof asli apa adanya antara Gateway dan Doorlock secara langsung, tanpa mengetahui kata sandi sama sekali — pola yang identik dengan pencurian kendaraan *keyless entry* memakai dua alat relay. Tidak ada solusi murah yang menutup celah ini sepenuhnya. Mitigasi yang diterapkan untuk mempersempitnya:

1. Gateway memverifikasi bahwa MAC pengirim balasan (dari parameter radio, bukan isi pesan) sama persis dengan MAC yang mengirim TAG — sudah diterapkan pada `onReceive` Gateway (lihat 3.4).
2. Mode pairing hanya aktif dalam jendela waktu terbatas dan dipicu manual lewat perintah `"Pairing"`, bukan menyala terus-menerus.
3. Hasil pairing yang berhasil rencananya disimpan permanen (*bonding*) agar proses ini hanya berlangsung sekali di pemasangan awal — belum diterapkan pada kode saat ini.

## 6. Status Implementasi

Tag identifikasi, antrian pairing satu per satu, dan verifikasi HMAC dengan nonce sudah diterapkan pada [Test/2. Autentikasi HMAC](../../Test/2.%20Autentikasi%20HMAC/) serta kode aktif di `Firmware/`. Yang belum diterapkan: kata sandi turunan per unit (bagian 4), enkripsi PMK/LMK untuk command LOCK/UNLOCK setelah pairing, dan penyimpanan permanen hasil pairing (*bonding*).

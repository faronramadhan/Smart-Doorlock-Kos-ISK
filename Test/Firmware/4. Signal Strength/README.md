# Signal Strength

Percobaan buat ngukur stabilitas kekuatan sinyal ESP-NOW antara 3 Doorlock dan 1 Gateway, sambil Doorlock-nya dibawa berpindah menjauh dari Gateway. Firmware Doorlock identik dengan [Peer Management](../3.%20Peer%20Management/). Firmware Gateway-nya beda dikit: `listening` di-set `true` permanen sejak boot (nggak butuh command `Pairing` dan nggak pernah timeout balik idle) — soalnya di pengujian ini Gateway cuma dicolok adaptor, nggak ada PC/serial yang bisa ngirim command ke dia sama sekali.

## Perangkat

| Perangkat  | Board | Port |
|------------|-------|------|
| Doorlock 1 | DFRobot Beetle ESP32-C3 | COM29 |
| Doorlock 2 | DFRobot Beetle ESP32-C3 | COM30 |
| Doorlock 3 | DFRobot Beetle ESP32-C3 | COM31 |
| Gateway    | DFRobot Beetle ESP32-C3 | COM28 |

Gateway statis di satu titik, dicolok ke adaptor doang (power only, nggak ada koneksi PC). Ketiga Doorlock dibawa berpindah menjauh dari Gateway sambil tetap konek ke PC (misal lewat USB hub di laptop yang ikut dibawa), supaya `LogRSSI.py` tetap bisa baca serial-nya selama perpindahan.

## Cara Kerja RSSI Streaming

Sumber datanya dari fitur yang udah ditambahkan di firmware Doorlock: begitu `paired == true`, Doorlock kirim heartbeat 1 byte (`MSG_PING`) ke Gateway tiap 1 detik, Gateway balas `MSG_PONG`, dan Doorlock nyadap balasan itu lewat WiFi promiscuous callback buat baca `rssi`-nya langsung dari header radio. Detailnya ada di kode `onSniff()` — bukan bagian baru dari Test 4, cuma dipakai di sini sebagai sumber data. Setiap detik, Doorlock nyetak baris:

```
RSSI Gateway: -47 dBm
```

ke Serial Monitor-nya masing-masing.

## Prasyarat

Gateway udah listening sejak dia nyala (lihat firmware-nya di atas), jadi nggak ada langkah manual yang perlu dilakuin ke Gateway sama sekali — tinggal colok adaptor dan biarin nyala.

## Skrip: `LogRSSI.py`

```python
PORTS = {
    "Doorlock 1": "COM29",
    "Doorlock 2": "COM30",
    "Doorlock 3": "COM31",
}
BAUD_RATE = 115200
DURATION_SECONDS = 60
```

Urutan kerjanya:

1. Buka ketiga port, kirim `Pairing` ke tiap Doorlock (nge-trigger bonding baru kalau belum pernah, atau reconnect kalau sebelumnya sempat putus).
2. Tunggu sampai ketiga Doorlock ngirim baris `RSSI Gateway: ...` pertama kalinya — itu bukti mereka udah `paired` dan heartbeat-nya jalan. Tiap device yang connect di-print satu-satu (`[Doorlock X] Connect! (n/3)`).
3. Begitu ketiganya connect, mulai logging 60 detik: tiap baris yang cocok pola `RSSI Gateway: (-?\d+) dBm` dicatat sebagai `[timestamp, nama_doorlock, port, rssi]` ke list `rows` dan langsung di-print ke terminal.
4. Setelah `DURATION_SECONDS` berlalu, `rows` ditulis ke `rssi_log.csv`.

## Dependensi

```
pip install pyserial
```

## Menjalankan

1. Pastikan ketiga Doorlock nyala dan konek ke PC di port yang sesuai (`COM29`–`COM31`), Gateway nyala (dicolok adaptor).
2. Jalankan:
   ```
   python LogRSSI.py
   ```
3. Bawa Doorlock berpindah menjauh dari Gateway selama skrip berjalan (1 menit).
4. Setelah selesai, buka `rssi_log.csv` — kolomnya: `timestamp`, `doorlock`, `port`, `rssi_dbm`.

## Format Output

| timestamp | doorlock | port | rssi_dbm |
|-----------|----------|------|----------|
| 2026-09-15T10:00:01.203 | Doorlock 1 | COM29 | -42 |
| 2026-09-15T10:00:01.210 | Doorlock 2 | COM30 | -39 |
| 2026-09-15T10:00:02.204 | Doorlock 1 | COM29 | -45 |
| ... | ... | ... | ... |

Karena tiap Doorlock ping tiap 1 detik, dalam 60 detik idealnya tiap device punya ~60 baris data. Baris yang lebih sedikit dari itu nunjukin ada paket ping/pong yang hilang (indikasi sinyal mulai nggak stabil) — jarak antar-timestamp yang melebar dari ~1 detik adalah tanda paling gampang buat dicek pertama kali.

## Hasil Pengujian

Tiga skenario jarak/kondisi diuji dengan setup antena standar (dataset dengan "Antenna Badag" dikecualikan dari rekap ini karena pakai antena berbeda, jadi nggak apple-to-apple dibanding baseline). Angka di bawah dihitung dari file CSV mentah masing-masing skenario.

| Skenario | Doorlock | n (baris) | RSSI min | RSSI max | RSSI rata-rata |
|----------|----------|-----------|----------|----------|-----------------|
| [1 Meter — Tanpa Penghalang](1%20Meter%E2%80%94Tanpa%20Penghalang.csv) | Doorlock 1 | 179 | -58 dBm | -40 dBm | -49.1 dBm |
| | Doorlock 2 | 179 | -51 dBm | -38 dBm | -42.3 dBm |
| | Doorlock 3 | 180 | -48 dBm | -37 dBm | -42.5 dBm |
| [6 Meter — Dengan Penghalang](6%20Meter%E2%80%94Dengan%20Penghalang.csv) | Doorlock 1 | 174 | -53 dBm | -47 dBm | -51.4 dBm |
| | Doorlock 2 | 176 | -55 dBm | -49 dBm | -52.3 dBm |
| | Doorlock 3 | 172 | -71 dBm | -59 dBm | -63.4 dBm |
| [10 Meter — Beda Lantai](10%20Meter%E2%80%94Beda%20Lantai.csv) | Doorlock 1 | 165 | -85 dBm | -77 dBm | -80.9 dBm |
| | Doorlock 2 | 164 | -81 dBm | -71 dBm | -77.3 dBm |
| | Doorlock 3 | 164 | -78 dBm | -71 dBm | -75.0 dBm |

### Observasi

- **1 meter, tanpa penghalang** — RSSI paling kuat dan paling stabil (rata-rata sekitar -42 s/d -49 dBm), sesuai ekspektasi karena jarak paling dekat dan line-of-sight bersih.
- **6 meter, dengan penghalang** — RSSI turun ke kisaran -51 s/d -63 dBm. Doorlock 3 paling terdampak (rata-rata -63.4 dBm, sampai -71 dBm), kemungkinan posisinya paling terhalang dibanding Doorlock 1 dan 2 saat pengujian.
- **10 meter, beda lantai** — RSSI paling lemah di semua device (-75 s/d -85 dBm), sesuai dugaan karena sinyal WiFi harus tembus lantai/plafon selain jarak yang jauh. Meski begitu, ketiga Doorlock masih tetap `paired` dan berhasil ngirim heartbeat tanpa putus koneksi total selama sesi logging, meskipun RSSI-nya sudah mendekati batas bawah yang umum dianggap "lemah" untuk WiFi (~-80 dBm ke bawah).
- Secara umum RSSI turun konsisten seiring jarak bertambah dan makin banyak penghalang (line-of-sight → dinding → beda lantai), sesuai perilaku propagasi sinyal 2.4 GHz yang diharapkan.

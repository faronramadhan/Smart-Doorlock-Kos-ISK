# Output RFID

Percobaan buat ngebaca output motor (`M+` dan `M-`) dari modul Doorlock original lewat ADC ESP32-C3. Waktu RFID modul original nge-approve kartu, modul itu ngeluarin tegangan sampai ±4 V ke motor buat unlock. Tegangan ini yang disadap ESP32-C3 supaya status unlock bisa diintegrasiin ke website.

Fokus test ini cuma satu: mastiin ADC ESP32-C3 bisa baca perubahan tegangan `M+` dan `M-` dengan benar.

## Perangkat

| Perangkat | Board | Port |
|-----------|-------|------|
| Doorlock  | DFRobot Beetle ESP32-C3 | COM29 |

GND modul Doorlock original **harus nyambung** ke GND ESP32-C3. Tanpa ground bersama, tegangan yang kebaca nggak ada artinya.

## Rangkaian

Diambil dari [Doorlock.kicad_sch](../../../Hardware/Doorlock/Doorlock.kicad_sch).

| Net | Pin ESP32-C3 | Divider |
|-----|--------------|---------|
| `M+` | GPIO0 (ADC1) | R1 200 kΩ (atas), R2 100 kΩ (ke GND) |
| `M-` | GPIO1 (ADC1) | R3 200 kΩ (atas), R4 100 kΩ (ke GND) |

```
M+ ── R1 (200k) ──┬── R2 (100k) ── GND
                  └── GPIO0

M- ── R3 (200k) ──┬── R4 (100k) ── GND
                  └── GPIO1
```

## Teori

```
V_GPIO = V_M × 100k / (200k + 100k) = V_M / 3
V_M    = V_GPIO × 3
```

| Tegangan M+/M- | Tegangan di GPIO |
|----------------|------------------|
| 0 V (idle) | 0 V |
| 4 V (unlock) | 1.33 V |
| 6.5 V (maks, kalau sampai tegangan baterai penuh) | 2.17 V |

Semua masih di bawah ±2.5 V, batas atas rentang akurat ADC ESP32-C3 dengan attenuation 11 dB. GPIO0 dan GPIO1 dua-duanya ADC1, jadi aman dipakai bareng ESP-NOW/WiFi nantinya.

Motor digerakin lewat H-bridge, jadi arah putaran ditentuin dari terminal mana yang lebih tinggi: `M+` tinggi, `M-` rendah untuk satu arah, dan sebaliknya untuk arah lain. Karena itu kedua terminal diukur terpisah terhadap GND.

## Program

```cpp
int rawPlus = analogRead(M_PLUS_PIN);
int rawMinus = analogRead(M_MINUS_PIN);

float voltPlus = analogReadMilliVolts(M_PLUS_PIN) * 3.0 / 1000.0;
float voltMinus = analogReadMilliVolts(M_MINUS_PIN) * 3.0 / 1000.0;

Serial.printf("M+: %d (%.2f V) | M-: %d (%.2f V)\n", rawPlus, voltPlus, rawMinus, voltMinus);
delay(50);
```

1. `analogRead()` ngasih nilai RAW ADC (0–4095, 12 bit).
2. `analogReadMilliVolts()` ngasih tegangan di GPIO dalam mV (udah dikoreksi kalibrasi chip), terus dikali 3 (rasio divider) dan dibagi 1000 → tegangan asli `M+`/`M-` dalam Volt.
3. Dibaca tiap 50 ms, soalnya pulsa motor waktu unlock biasanya cuma sebentar (ratusan ms). Kalau interval-nya kelamaan, pulsanya bisa kelewat.

### Output Serial

```
M+: 0 (0.00 V) | M-: 0 (0.00 V)
M+: 1650 (4.00 V) | M-: 0 (0.00 V)
```

## Skrip: `LogRFID.py`

Nyimpen pembacaan serial ke `OutputRFID.csv` selama 60 detik, lengkap dengan timestamp PC tiap baris. Tiap baris juga langsung di-print ke terminal.

```
pip install pyserial
python LogRFID.py
```

Tutup Serial Monitor PlatformIO dulu sebelum jalanin skrip, soalnya port COM cuma bisa dibuka satu program.

| timestamp | m_plus_raw | m_plus_volt | m_minus_raw | m_minus_volt |
|-----------|------------|-------------|-------------|--------------|
| 2026-09-27T10:00:01.203 | 0 | 0.00 | 0 | 0.00 |
| 2026-09-27T10:00:01.254 | 1650 | 4.00 | 0 | 0.00 |
| ... | ... | ... | ... | ... |

## Test Procedure

1. Salin isi `Doorlock.cpp` ke `Firmware/Doorlock/src/main.cpp`, lalu upload lewat PlatformIO (COM29).
2. Pastikan GND modul Doorlock original nyambung ke GND ESP32-C3.
3. Buka Serial Monitor (115200 baud). Waktu idle, `M+` dan `M-` harusnya ±0 V.
4. Tempel kartu RFID yang terdaftar. Perhatiin terminal mana yang naik (`M+` atau `M-`), berapa tegangannya, dan berapa lama pulsanya (hitung jumlah baris × 50 ms).
5. **Validasi akurasi**: ukur `M+`/`M-` ke GND pakai multimeter waktu unlock, bandingin sama nilai di serial.
6. Tunggu sampai pintu ngunci lagi (kalau modul otomatis lock). Cek apakah terminal yang lain yang naik, buat mastiin arah H-bridge-nya.
7. Tempel kartu yang **nggak** terdaftar. `M+` dan `M-` harusnya tetap ±0 V.

## Hasil Pengujian

| Kondisi | M+ multimeter | M+ serial (RAW / V) | M- multimeter | M- serial (RAW / V) | Durasi pulsa |
|---------|---------------|---------------------|---------------|---------------------|--------------|
| Idle | | | | | – |
| Unlock (kartu valid) | | | | | |
| Lock | | | | | |
| Kartu tidak valid | | | | | – |

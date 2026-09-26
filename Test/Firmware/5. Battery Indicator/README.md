# Battery Indicator

Percobaan buat ngukur tegangan baterai Doorlock (4× AAA) lewat ADC ESP32-C3. Pengukuran **cuma dilakukan waktu push button ditekan**: firmware nyalain `BAT_EN` sebentar, baca `BAT_IND`, lalu matiin `BAT_EN` lagi. Tujuannya supaya divider tegangan nggak nyedot arus baterai terus-terusan waktu nggak dipakai.

## Perangkat

| Perangkat | Board | Port |
|-----------|-------|------|
| Doorlock  | DFRobot Beetle ESP32-C3 | COM29 |

Sumber daya: 4× AAA seri ke `VCC`.

## Rangkaian

Diambil dari [Doorlock.kicad_sch](../../../Hardware/Doorlock/Doorlock.kicad_sch).

| Net | Pin ESP32-C3 | Keterangan |
|-----|--------------|------------|
| `BAT_EN` | GPIO21 | Output, HIGH = pengukuran aktif |
| `BAT_IND` | GPIO4 (ADC1) | Input analog, hasil divider |
| SW1 | GPIO20 | Push button ke GND (aktif LOW, pakai pull-up internal) |

| Komponen | Nilai | Fungsi |
|----------|-------|--------|
| Q2 | AO3401A (P-MOSFET) | Saklar high-side antara `VCC` dan divider |
| Q3 | NPN | Penarik gate Q2 ke GND, dikontrol `BAT_EN` |
| R5 | 100 kΩ | Pull-up gate Q2 ke `VCC` (Q2 OFF secara default) |
| R8 | 100 kΩ | Resistor basis Q3 |
| R6 | 200 kΩ | Divider atas |
| R7 | 100 kΩ | Divider bawah |

## Teori

### Saklar High-Side

```
BAT_EN HIGH → Q3 ON → gate Q2 = GND → Vgs Q2 = −VCC → Q2 ON  → VCC masuk ke divider
BAT_EN LOW  → Q3 OFF → R5 narik gate Q2 ke VCC → Vgs = 0 → Q2 OFF → BAT_IND = 0 V (lewat R7)
```

Waktu `BAT_EN` LOW, divider putus total dari `VCC`, jadi nggak ada arus bocor dari baterai lewat R6/R7. Waktu `BAT_EN` HIGH, arus yang kepakai cuma sekitar `VCC/300k + VCC/100k` (divider + R5), di bawah 100 µA, dan itu pun cuma selama ±20 ms tiap pengukuran.

### Voltage Divider

```
BAT_IND = VCC × R7 / (R6 + R7) = VCC × 100k / 300k = VCC / 3
VCC     = BAT_IND × 3
```

| Kondisi | VCC (4× AAA) | BAT_IND |
|---------|--------------|---------|
| Alkaline baru (1.6 V/sel) | 6.4 V | 2.13 V |
| Alkaline nominal (1.5 V/sel) | 6.0 V | 2.00 V |
| NiMH nominal (1.2 V/sel) | 4.8 V | 1.60 V |
| Hampir habis (1.0 V/sel) | 4.0 V | 1.33 V |
| Habis total (0.9 V/sel) | 3.6 V | 1.20 V |

Semua masih di bawah ±2.5 V, batas atas rentang akurat ADC ESP32-C3 dengan attenuation 11 dB. `BAT_IND` sengaja ditaruh di GPIO4 (ADC1), soalnya ADC2 di ESP32-C3 nggak bisa dipakai bareng radio (ESP-NOW/WiFi).

## Program

```cpp
if (digitalRead(BUTTON_PIN) == LOW) {
  digitalWrite(BAT_EN_PIN, HIGH);
  delay(20);

  int adc = analogReadMilliVolts(BAT_IND_PIN);
  digitalWrite(BAT_EN_PIN, LOW);

  float battery = adc * 3.0 / 1000.0;
  Serial.printf("ADC: %d mV | Baterai: %.2f V\n", adc, battery);

  while (digitalRead(BUTTON_PIN) == LOW);
  delay(50);
}
```

Alurnya:

1. Tombol ditekan → pin kebaca `LOW` (pakai `INPUT_PULLUP`, tombol nyambung ke GND).
2. `BAT_EN` di-HIGH-kan, tunggu 20 ms supaya Q3/Q2 ON penuh dan tegangan divider stabil.
3. `analogReadMilliVolts()` baca `BAT_IND` langsung dalam satuan mV (udah dikoreksi kalibrasi chip).
4. `BAT_EN` langsung di-LOW-kan lagi, supaya divider nggak nyedot baterai.
5. Hasil ADC dikali 3.0 (rasio divider) terus dibagi 1000 → tegangan baterai dalam Volt.
6. `while (...)` nunggu tombol dilepas, jadi satu tekanan = satu pengukuran. `delay(50)` buat ngeredam bouncing tombol waktu dilepas.

### Output Serial

```
ADC: 2104 mV | Baterai: 6.31 V
```

## Test Procedure

1. Salin isi `Doorlock.cpp` ke `Firmware/Doorlock/src/main.cpp`, lalu upload lewat PlatformIO (COM29).
2. Pasang 4× AAA ke `VCC`, buka Serial Monitor (115200 baud).
3. Tekan SW1 sekali. Pastikan cuma keluar **satu** baris hasil per tekanan, termasuk waktu tombol ditahan.
4. **Validasi akurasi**: ukur tegangan `VCC` pakai multimeter, bandingin dengan nilai `Baterai` di serial. Catat selisihnya di tabel hasil.
5. **Validasi pin `BAT_IND` saat idle**: dengan tombol dilepas, ukur `BAT_IND` ke GND pakai multimeter. Harusnya 0 V, yang membuktikan divider bener-bener putus waktu `BAT_EN` LOW.
6. Ulangi langkah 3–4 pakai baterai dengan kondisi berbeda (baru, setengah pakai, hampir habis), atau pakai power supply variabel dari 3.6 V sampai 6.4 V.

## Hasil Pengujian

Diukur dengan 4× AAA, R6 = 200 kΩ, R7 = 100 kΩ. Tegangan baterai dibandingkan dengan multimeter.

| Parameter | Teori | Realita | Selisih |
|-----------|-------|---------|---------|
| VCC (baterai) | 6.51 V (multimeter) | 6.31 V (terbaca firmware) | −0.20 V (−3.1%) |
| BAT_IND | 2.17 V (6.51 V ÷ 3) | 2104 mV (`analogReadMilliVolts`) | −66 mV (−3.0%) |
| Rasio divider | 3.000 | 3.094 (6.51 V ÷ 2.104 V) | +3.1% |

### Observasi

- **Resistor divider sempat tertukar.** Awalnya 100 kΩ kepasang di atas dan 200 kΩ di bawah, jadi `BAT_IND` ±4 V (VCC × 200k/300k), di atas batas 3.3 V GPIO, dan ADC jenuh di RAW 4095. Setelah posisinya dibenerin, `BAT_IND` kembali ±2.1 V sesuai teori.
- **Firmware baca ±3% lebih rendah dari multimeter.** Kemungkinan penyebabnya gabungan dari toleransi resistor (5%), impedansi divider yang tinggi (±67 kΩ) buat kapasitor sampling ADC, dan error bawaan ADC ESP32-C3.
- **Koreksi**: pakai pengali empiris **3.094** (bukan 3.0) biar hasil firmware sama dengan multimeter, atau tambah kapasitor 100 nF paralel R7 biar pembacaan ADC lebih stabil. Pengali empiris sebaiknya divalidasi lagi di 2–3 titik tegangan berbeda.

# Product Component

## Doorlock

1. ESP32-C3 (Pro Mini)
2. DRV8833
3. P-channel MOSFET (reverse polarity protection)
4. Capacitor low-ESR 330-470uF (bulk/reservoir, taruh di rail 3.3V, dempet ke modul ESP32-C3)
5. LDO onboard modul ESP32-C3 Pro Mini (feed lewat pin 5V/VIN, gak perlu beli terpisah)
6. Input capacitor buat LDO (sebelum VIN/5V, ceramic ~1-10uF)
7. Capacitor low-ESR (bulk lokal di pin VM DRV8833, terpisah dari cap ESP32, nilai TBD nunggu ukur stall current motor)
8. Resistor 3.9kOhm — 2 pcs (R1, sinyal M_POS/M_NEG dari PCB pabrik ke node GPIO)
9. Resistor 10kOhm — 2 pcs (R2, node GPIO ke GND — pasangan divider M_POS/M_NEG)
10. Diode 1N4148 — 4 pcs (clamp protection GPIO M_POS/M_NEG: 2 ke GND, 2 ke 3.3V)

### Catatan & Checklist (bukan item beli)

- LED RGB onboard modul ESP32-C3 wajib dicopot/desolder — kontributor terbesar ke deep sleep current.
- LED indikator power onboard modul DRV8833 wajib dicopot/desolder — bisa narik 1-10mA terus-menerus, berpotensi ngabisin seluruh kapasitas baterai dalam <1 bulan sendirian.
- Pastikan kabel motor fisik CUMA konek ke OUT DRV8833 — JANGAN sampai masih paralel ke output H-bridge PCB RFID pabrik (resiko dua driver aktif bareng/contention, bisa ngerusak driver).
- Verifikasi sinyal M_POS/M_NEG dari PCB pabrik pakai oscilloscope/logic analyzer sebelum finalisasi — pastiin gak ada PWM/noise yang butuh Schmitt trigger (74HC14) tambahan.
- Cek idle state GPIO M_POS/M_NEG: defined LOW atau floating? Kalau floating, tambah pull-down resistor ~100kOhm buat cegah spurious wake dari deep sleep.
- Ukur standalone current draw PCB RFID pabrik (idle & saat approve event) buat tau sisa power budget yang available buat tambahan ESP32-C3 + DRV8833.
- Cek breakout board lain (kalau ada) buat LED indikator serupa sebelum final assembly.
- Firmware: cache channel ESP-NOW terakhir di RTC_DATA_ATTR biar gak full channel-hop pairing tiap wake dari deep sleep (hemat energi per unlock event).

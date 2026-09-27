#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_sleep.h>
#include <driver/gpio.h>
#include <mbedtls/md.h>
#include <Preferences.h>

/* ===== PIN (Hardware/Doorlock/Doorlock.kicad_sch) ===== */
#define M_PLUS_PIN     0    // output motor modul doorlock original, lewat divider 200k/100k
#define M_MINUS_PIN    1
#define BAT_IND_PIN    4    // divider baterai 200k/100k
#define DRV_SLEEP_PIN  5    // EEP DRV8833, LOW = driver tidur
#define DRV_IN1_PIN    6
#define DRV_IN2_PIN    7
#define BUTTON_PIN     20
#define BAT_EN_PIN     21

// Pulsa modul original: M- naik dulu (kartu diterima), ±6 detik kemudian M+ naik (kunci otomatis) — hasil Test 6.
// Tukar kalau ternyata terbalik.
#define MODULE_UNLOCK_PIN M_MINUS_PIN
#define MODULE_LOCK_PIN   M_PLUS_PIN

/* ===== KONFIGURASI ===== */
// 0 = tidak benar-benar tidur (radio tetap mati), supaya USB Serial tidak putus saat logging pengujian
#define LIGHT_SLEEP       0
#define LONG_PRESS_TIME   5000
#define PAIRING_TIMEOUT   60000
#define CHANNEL_HOP_MS    400    // lama menunggu beacon gateway di tiap channel
#define TAG_INTERVAL_MS   500
#define REPLY_TIMEOUT_MS  500    // batas tunggu balasan status blokir RFID dari gateway
#define MOTOR_PULSE_MS    350    // sama dengan pulsa motor modul original (Test 6)
#define BAT_FULL_MV       6400   // 4x AAA baru (1.6 V/sel)
#define BAT_EMPTY_MV      4000   // 4x AAA habis (1.0 V/sel)

/* ===== PROTOKOL (sama dengan Firmware/Gateway) ===== */
const uint8_t broadcastAddress[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 };
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

#define MSG_DISCONNECT 2  // doorlock -> gateway: pamit sebelum pairing ulang
#define MSG_BEACON     5  // gateway -> broadcast: mode pairing aktif di channel ini

#define DOOR_MSG_HEADER 0xD0
#define CMD_RFID_ALLOW  0x03
#define CMD_RFID_BLOCK  0x04
#define EVT_LOCKED      0x11
#define EVT_UNLOCKED    0x12

typedef struct {
  uint8_t header;
  uint8_t code;
} DoorMessage;

#define DOOR_STATUS_HEADER 0xD1
typedef struct {
  uint8_t header;
  uint8_t battery;   // 0-100 %
  uint8_t unlocked;  // 1 = terbuka, 0 = terkunci
} DoorStatusMessage;

/* ===== STATE ===== */
Preferences prefs;

bool paired = false;
uint8_t gatewayMac[6];
uint8_t gatewayChannel = 1;
uint8_t currentChannel = 1;
bool unlocked = false;

volatile bool rfidAllowed = true;
volatile bool rfidReplied = false;
volatile bool searching = false;
volatile bool channelFound = false;

// RSSI paket ESP-NOW terakhir untuk log activity
volatile int lastRssi = 0;
volatile int replyRssi = 0;

/* ===== ESP-NOW ===== */
void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void addPeer(const uint8_t *mac) {
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  esp_now_add_peer(&peer);
}

void setChannel(uint8_t channel) {
  currentChannel = channel;
  esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
}

// ESP-NOW dikirim sebagai action frame (frame control 0xD0)
void onSniff(void *buf, wifi_promiscuous_pkt_type_t type) {
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t*)buf;
  if (pkt->payload[0] == 0xD0) lastRssi = pkt->rx_ctrl.rssi;
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  replyRssi = lastRssi;

  if (searching && len == 1 && data[0] == MSG_BEACON) {
    channelFound = true;
    return;
  }

  if (searching && channelFound && len == sizeof(AuthMessage)) {
    const AuthMessage *challenge = (const AuthMessage*)data;
    addPeer(mac);

    AuthMessage response;
    response.nonce = challenge->nonce;
    computeProof(challenge->nonce, response.proof);
    esp_now_send(mac, (uint8_t*)&response, sizeof(response));

    memcpy(gatewayMac, mac, 6);
    gatewayChannel = currentChannel;
    paired = true;
    searching = false;
    return;
  }

  if (paired && memcmp(mac, gatewayMac, 6) == 0 && len == sizeof(DoorMessage) && data[0] == DOOR_MSG_HEADER) {
    if (data[1] == CMD_RFID_ALLOW || data[1] == CMD_RFID_BLOCK) {
      rfidAllowed = data[1] == CMD_RFID_ALLOW;
      rfidReplied = true;
    }
  }
}

void radioOn() {
  WiFi.mode(WIFI_STA);
  setChannel(gatewayChannel);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);
  addPeer(broadcastAddress);
  if (paired) addPeer(gatewayMac);

  wifi_promiscuous_filter_t filter = { WIFI_PROMIS_FILTER_MASK_MGMT };
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(onSniff);
  esp_wifi_set_promiscuous(true);
}

void radioOff() {
  delay(50);  // beri waktu paket terakhir terkirim
  esp_now_deinit();
  WiFi.mode(WIFI_OFF);
}

void sendToGateway(const void *data, size_t len) {
  esp_now_send(gatewayMac, (const uint8_t*)data, len);
}

void savePairing() {
  prefs.putBool("paired", paired);
  prefs.putBytes("gateway", gatewayMac, 6);
  prefs.putUChar("channel", gatewayChannel);
}

/* ===== HARDWARE ===== */
int readBatteryPercent() {
  digitalWrite(BAT_EN_PIN, HIGH);
  delay(20);
  int batteryMilliVolts = analogReadMilliVolts(BAT_IND_PIN) * 3;
  digitalWrite(BAT_EN_PIN, LOW);

  return constrain((batteryMilliVolts - BAT_EMPTY_MV) * 100 / (BAT_FULL_MV - BAT_EMPTY_MV), 0, 100);
}

// Pulsa HIGH/LOW seperti modul original, DRV8833 hanya aktif selama motor bergerak
void driveMotor(bool unlock) {
  digitalWrite(DRV_SLEEP_PIN, HIGH);
  delay(1);
  digitalWrite(DRV_IN1_PIN, unlock ? HIGH : LOW);
  digitalWrite(DRV_IN2_PIN, unlock ? LOW : HIGH);
  delay(MOTOR_PULSE_MS);

  digitalWrite(DRV_IN1_PIN, LOW);
  digitalWrite(DRV_IN2_PIN, LOW);
  digitalWrite(DRV_SLEEP_PIN, LOW);
  unlocked = unlock;
}

/* ===== AKSI SETELAH BANGUN ===== */
// Kartu RFID ditempel (M-) atau kunci otomatis (M+): cek blokir ke gateway, gerakkan motor, lapor, lalu tidur lagi
void handleModule(bool unlock) {
  Serial.printf("[ACT] Bangun: %s\n", unlock ? "kartu RFID ditempel" : "kunci otomatis");

  if (paired) {
    radioOn();
    rfidReplied = false;
    int battery = readBatteryPercent();
    DoorStatusMessage status = { DOOR_STATUS_HEADER, (uint8_t)battery, unlocked };
    sendToGateway(&status, sizeof(status));
    Serial.printf("[ACT] Status terkirim, baterai %d%%\n", battery);

    unsigned long start = millis();
    while (!rfidReplied && millis() - start < REPLY_TIMEOUT_MS) delay(5);
    if (rfidReplied) Serial.printf("[ACT] Balasan Gateway: RFID %s (RSSI %d)\n", rfidAllowed ? "ALLOW" : "BLOCK", replyRssi);
    else Serial.println("[ACT] Gateway tidak membalas, pakai status blokir terakhir");
    prefs.putBool("rfid", rfidAllowed);
  }

  if (unlock && !rfidAllowed) {
    Serial.println("[ACT] Kartu RFID ditolak, akses sedang diblokir");
  } else {
    driveMotor(unlock);
    Serial.printf("[ACT] Motor %s\n", unlock ? "UNLOCK" : "LOCK");
    if (paired) {
      DoorMessage event = { DOOR_MSG_HEADER, (uint8_t)(unlock ? EVT_UNLOCKED : EVT_LOCKED) };
      sendToGateway(&event, sizeof(event));
      Serial.printf("[ACT] Event %s terkirim\n", unlock ? "UNLOCKED" : "LOCKED");
    }
  }

  if (paired) radioOff();
}

// Tombol ditahan: pamit ke gateway lama, hapus pairing, lalu cari gateway yang sedang mode pairing
void pairing() {
  Serial.println("[ACT] Tombol pairing ditahan 5 detik");
  radioOn();

  if (paired) {
    uint8_t signal = MSG_DISCONNECT;
    sendToGateway(&signal, sizeof(signal));
    delay(50);
    esp_now_del_peer(gatewayMac);
    paired = false;
    savePairing();
    Serial.println("[ACT] Disconnect terkirim, pairing lama dihapus");
  }

  Serial.println("[ACT] Mencari Gateway yang sedang mode pairing");
  channelFound = false;
  searching = true;
  bool announced = false;
  unsigned long start = millis();
  while (searching && millis() - start < PAIRING_TIMEOUT) {
    if (!channelFound) {
      setChannel(currentChannel % 13 + 1);
      delay(CHANNEL_HOP_MS);
      continue;
    }
    if (!announced) {
      announced = true;
      Serial.printf("[ACT] Beacon Gateway ditemukan di channel %d (RSSI %d), kirim TAG\n", currentChannel, replyRssi);
    }
    esp_now_send(broadcastAddress, TAG, sizeof(TAG));
    delay(TAG_INTERVAL_MS);
  }
  searching = false;

  if (paired) {
    savePairing();
    Serial.printf("[ACT] Challenge diterima, proof terkirim, terhubung di channel %d (RSSI %d)\n", gatewayChannel, replyRssi);
  } else {
    Serial.println("[ACT] Timeout, Gateway tidak ditemukan");
  }
  radioOff();
}

bool heldFor(unsigned long duration) {
  unsigned long start = millis();
  while (digitalRead(BUTTON_PIN) == LOW) {
    if (millis() - start >= duration) return true;
    delay(10);
  }
  return false;
}

// Light sleep sampai ada pulsa modul (M+/M- HIGH) atau tombol ditekan (LOW). Radio sudah mati di titik ini.
void sleepUntilActivity() {
  while (digitalRead(M_PLUS_PIN) || digitalRead(M_MINUS_PIN) || digitalRead(BUTTON_PIN) == LOW) delay(10);
  Serial.println("[ACT] Tidur");
  Serial.flush();

#if !LIGHT_SLEEP
  while (!digitalRead(M_PLUS_PIN) && !digitalRead(M_MINUS_PIN) && digitalRead(BUTTON_PIN) == HIGH) delay(1);
  return;
#endif

  gpio_wakeup_enable((gpio_num_t)M_PLUS_PIN, GPIO_INTR_HIGH_LEVEL);
  gpio_wakeup_enable((gpio_num_t)M_MINUS_PIN, GPIO_INTR_HIGH_LEVEL);
  gpio_wakeup_enable((gpio_num_t)BUTTON_PIN, GPIO_INTR_LOW_LEVEL);
  esp_sleep_enable_gpio_wakeup();
  esp_light_sleep_start();
}

/* ===== SETUP & LOOP ===== */
void setup() {
  Serial.begin(115200);
  pinMode(M_PLUS_PIN, INPUT);
  pinMode(M_MINUS_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BAT_EN_PIN, OUTPUT);
  pinMode(DRV_SLEEP_PIN, OUTPUT);
  pinMode(DRV_IN1_PIN, OUTPUT);
  pinMode(DRV_IN2_PIN, OUTPUT);

  prefs.begin("doorlock", false);
  paired = prefs.getBool("paired", false);
  prefs.getBytes("gateway", gatewayMac, 6);
  gatewayChannel = prefs.getUChar("channel", 1);
  rfidAllowed = prefs.getBool("rfid", true);
}

void loop() {
  sleepUntilActivity();

  if (digitalRead(BUTTON_PIN) == LOW) {
    if (heldFor(LONG_PRESS_TIME)) pairing();
  } else if (digitalRead(MODULE_UNLOCK_PIN)) {
    handleModule(true);
  } else if (digitalRead(MODULE_LOCK_PIN)) {
    handleModule(false);
  }
}

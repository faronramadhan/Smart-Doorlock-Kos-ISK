#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <Preferences.h>

#define MSG_DISCONNECT 2
#define PAIRING_WINDOW_MS 60000
#define WIFI_CHANNEL 1

#define BUTTON_PIN 20
#define LONG_PRESS_MS 5000

#define M_PLUS_PIN 0
#define M_MINUS_PIN 1
#define MODULE_HIGH_MV 1000  // pulsa modul 4-6.4 V dibagi 3 (200k/100k) = 1.3-2.1 V, di bawah batas HIGH digital

#define DRV_SLEEP_PIN 5  // EEP DRV8833, LOW = driver tidur
#define DRV_IN1_PIN 6
#define DRV_IN2_PIN 7
#define PULSE_MAX_MS 2000  // batas aman kalau M+/M- tidak turun

#define BAT_IND_PIN 4
#define BAT_EN_PIN 21
#define BAT_FULL_MV 6400   // 4x AAA baru (1.6 V/sel)
#define BAT_EMPTY_MV 4000  // 4x AAA habis (1.0 V/sel)

#define REPLY_TIMEOUT_MS 500

#define DOOR_MSG_HEADER 0xD0
#define DOOR_STATUS_HEADER 0xD1
#define CMD_RFID_ALLOW 0x03
#define CMD_RFID_BLOCK 0x04
#define EVT_LOCKED 0x11
#define EVT_UNLOCKED 0x12
#define EVT_RFID_REJECTED 0x14

uint8_t broadcastAddress[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 };
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

typedef struct {
  uint8_t header;
  uint8_t code;
} DoorMessage;

typedef struct {
  uint8_t header;
  uint8_t battery;
  uint8_t unlocked;
} DoorStatusMessage;

Preferences prefs;

volatile bool broadcasting = false;
volatile bool paired = false;
volatile bool justPaired = false;
uint8_t gatewayMac[6];
unsigned long broadcastStartedAt = 0;
volatile bool rfidAccess = true;  // true = kartu diizinkan, false = diblokir
volatile bool rfidReplied = false;
unsigned long statusSentAt = 0;
bool unlocked = false;

unsigned long buttonPressedAt = 0;
bool buttonHandled = false;

bool lastMPlus = false;
bool lastMMinus = false;

int battery = -1;  // 0-100 %, -1 = belum dibaca

// RSSI paket ESP-NOW terakhir, diisi sebelum onReceive dipanggil
volatile int lastRssi = 0;

// ESP-NOW dikirim sebagai action frame (frame control 0xD0)
void onSniff(void *buf, wifi_promiscuous_pkt_type_t type) {
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t*)buf;
  if (pkt->payload[0] == 0xD0) lastRssi = pkt->rx_ctrl.rssi;
}

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void savePairing() {
  prefs.putBool("paired", paired);
  prefs.putBytes("gateway", gatewayMac, 6);
}

void loadPairing() {
  paired = prefs.getBool("paired", false);
  if (!paired) return;

  prefs.getBytes("gateway", gatewayMac, 6);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, gatewayMac, 6);
  esp_now_add_peer(&peer);

  Serial.println("Sudah terhubung ke Gateway (dari penyimpanan).");
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  // Status blokir kartu RFID dari gateway
  if (paired && memcmp(mac, gatewayMac, 6) == 0 && len == 2 && data[0] == DOOR_MSG_HEADER) {
    if (data[1] != CMD_RFID_ALLOW && data[1] != CMD_RFID_BLOCK) return;

    rfidAccess = data[1] == CMD_RFID_ALLOW;
    rfidReplied = true;
    return;
  }

  if (!broadcasting || len != sizeof(AuthMessage)) return;

  const AuthMessage *challenge = (const AuthMessage*)data;

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  esp_now_add_peer(&peer);

  AuthMessage response;
  response.nonce = challenge->nonce;
  computeProof(challenge->nonce, response.proof);
  esp_now_send(mac, (uint8_t*)&response, sizeof(response));

  memcpy(gatewayMac, mac, 6);
  broadcasting = false;
  paired = true;
  justPaired = true;
}

void disconnectFromGateway() {
  uint8_t signal = MSG_DISCONNECT;
  esp_now_send(gatewayMac, &signal, sizeof(signal));
  delay(50);
  esp_now_del_peer(gatewayMac);

  paired = false;
  memset(gatewayMac, 0, 6);
  rfidAccess = true;
  savePairing();
  prefs.putBool("rfid", true);

  Serial.println("Terputus dari Gateway lama.");
}

bool longPress() {
  if (digitalRead(BUTTON_PIN) == HIGH) {
    buttonPressedAt = millis();
    buttonHandled = false;
    return false;
  }

  if (buttonHandled || millis() - buttonPressedAt < LONG_PRESS_MS) return false;
  buttonHandled = true;
  return true;
}

bool moduleHigh(int pin) {
  return analogReadMilliVolts(pin) > MODULE_HIGH_MV;
}

// Divider baterai hanya dinyalakan selama pembacaan
int readBattery() {
  digitalWrite(BAT_EN_PIN, HIGH);
  delay(20);
  int batteryMv = analogReadMilliVolts(BAT_IND_PIN) * 3;
  digitalWrite(BAT_EN_PIN, LOW);

  int percent = constrain((batteryMv - BAT_EMPTY_MV) * 100 / (BAT_FULL_MV - BAT_EMPTY_MV), 0, 100);
  Serial.printf("Baterai %d mV (%d%%)\n", batteryMv, percent);
  return percent;
}

unsigned long waitPulseEnd(int pin, unsigned long risedAt) {
  while (moduleHigh(pin) && millis() - risedAt < PULSE_MAX_MS) delay(1);
  return millis() - risedAt;
}

void sendEvent(uint8_t code) {
  if (!paired) return;
  DoorMessage event = { DOOR_MSG_HEADER, code };
  esp_now_send(gatewayMac, (uint8_t*)&event, sizeof(event));
}

void sendStatus() {
  if (!paired) return;

  rfidReplied = false;
  DoorStatusMessage status = { DOOR_STATUS_HEADER, (uint8_t)battery, unlocked };
  esp_now_send(gatewayMac, (uint8_t*)&status, sizeof(status));
  statusSentAt = millis();
}

// Tunggu status BLOCK/ALLOW dari gateway, kalau tidak membalas pakai status terakhir
void waitRfidReply() {
  if (!paired) return;

  while (!rfidReplied && millis() - statusSentAt < REPLY_TIMEOUT_MS) delay(5);

  if (rfidReplied) {
    prefs.putBool("rfid", rfidAccess);
    Serial.printf("Gateway: %s (RSSI %d dBm)\n", rfidAccess ? "ALLOW" : "BLOCK", lastRssi);
  } else {
    Serial.printf("Gateway tidak membalas, pakai status terakhir: %s\n", rfidAccess ? "ALLOW" : "BLOCK");
  }
}

// Setiap pulsa: cek status BLOCK/ALLOW dulu, atur EEP, baru trigger IN selama lama pulsa asli
void handlePulse(int modulePin, int inPin, bool unlock) {
  unsigned long risedAt = millis();
  Serial.println(unlock ? "M+ HIGH" : "M- HIGH");
  if (unlock) battery = readBattery();
  sendStatus();
  unsigned long pulseMs = waitPulseEnd(modulePin, risedAt);
  waitRfidReply();

  if (!rfidAccess) {
    digitalWrite(DRV_SLEEP_PIN, LOW);
    if (unlock) sendEvent(EVT_RFID_REJECTED);
    Serial.println("BLOCK, motor tidak digerakkan");
    return;
  }

  digitalWrite(DRV_SLEEP_PIN, HIGH);
  delay(1);
  digitalWrite(inPin, HIGH);
  delay(pulseMs);
  digitalWrite(inPin, LOW);
  if (!unlock) digitalWrite(DRV_SLEEP_PIN, LOW);

  unlocked = unlock;
  sendEvent(unlock ? EVT_UNLOCKED : EVT_LOCKED);
  Serial.printf("%s %lu ms\n", unlock ? "Unlock" : "Lock", pulseMs);
}

void readModule() {
  bool mPlus = moduleHigh(M_PLUS_PIN);
  bool mMinus = moduleHigh(M_MINUS_PIN);

  if (mPlus && !lastMPlus) handlePulse(M_PLUS_PIN, DRV_IN1_PIN, true);
  if (mMinus && !lastMMinus) handlePulse(M_MINUS_PIN, DRV_IN2_PIN, false);

  lastMPlus = mPlus;
  lastMMinus = mMinus;
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(DRV_SLEEP_PIN, OUTPUT);
  pinMode(DRV_IN1_PIN, OUTPUT);
  pinMode(DRV_IN2_PIN, OUTPUT);
  digitalWrite(DRV_SLEEP_PIN, LOW);
  digitalWrite(DRV_IN1_PIN, LOW);
  digitalWrite(DRV_IN2_PIN, LOW);
  pinMode(BAT_EN_PIN, OUTPUT);
  digitalWrite(BAT_EN_PIN, LOW);
  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddress, 6);
  esp_now_add_peer(&peer);

  wifi_promiscuous_filter_t filter = { WIFI_PROMIS_FILTER_MASK_MGMT };
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(onSniff);
  esp_wifi_set_promiscuous(true);

  prefs.begin("doorlock", false);
  rfidAccess = prefs.getBool("rfid", true);
  loadPairing();
}

void loop() {
  if (!broadcasting) readModule();

  if (longPress() && !broadcasting) {
    if (paired) disconnectFromGateway();

    broadcasting = true;
    broadcastStartedAt = millis();
    Serial.println("Broadcast tag dimulai...");
  }

  if (justPaired) {
    justPaired = false;
    savePairing();
    Serial.printf("Terhubung ke Gateway %02X:%02X:%02X:%02X:%02X:%02X (RSSI %d dBm).\n",
                  gatewayMac[0], gatewayMac[1], gatewayMac[2], gatewayMac[3], gatewayMac[4], gatewayMac[5], lastRssi);
  }

  if (broadcasting && millis() - broadcastStartedAt > PAIRING_WINDOW_MS) {
    broadcasting = false;
    Serial.println("Timeout, kembali ke mode idle.");
  }

  if (broadcasting) {
    esp_now_send(broadcastAddress, (uint8_t*)TAG, sizeof(TAG));
    Serial.println("Pairing...");
    delay(500);
  }
}

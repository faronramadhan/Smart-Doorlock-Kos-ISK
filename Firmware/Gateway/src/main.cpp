#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_system.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <Preferences.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>
#include <WiFiManager.h>

#define WIFI_CHANNEL 1

#define BUTTON_WIFI_PIN 20
#define BUTTON_DOORLOCK_PIN 21
#define LONG_PRESS_TIME 5000

#define MAX_PEERS 20
#define MAX_QUEUE 20
#define MSG_DISCONNECT 2
#define MSG_PING 3
#define MSG_PONG 4
#define CHALLENGE_TIMEOUT 2000
#define PAIRING_TIMEOUT 60000

const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 };
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

Preferences prefs;
Adafruit_SSD1306 display(128, 64, &Wire, -1);
WiFiManager wm;

unsigned long wifiPressedAt = 0;
unsigned long doorlockPressedAt = 0;
bool wifiHandled = false;
bool doorlockHandled = false;
bool lastWifiState = HIGH;
bool lastDoorlockState = HIGH;

bool listening = false;
unsigned long listenStartedAt = 0;
int bondResult = 0;

uint8_t queueMac[MAX_QUEUE][6];
int queueCount = 0;

uint8_t skippedMac[MAX_QUEUE][6];
int skippedCount = 0;

bool confirming = false;
int candidateNumber = 0;
char candidateLabel[12];

uint8_t currentMac[6];
uint32_t currentNonce = 0;
unsigned long challengeSentAt = 0;
bool awaitingResponse = false;

int peerCount = 0;
uint8_t peers[MAX_PEERS][6];

void printCenter(const char *text, int y) {
  int x = (128 - strlen(text) * 12) / 2;
  display.setCursor(x, y);
  display.print(text);
}

void show(const char *line1, const char *line2) {
  display.clearDisplay();
  printCenter(line1, 14);
  printCenter(line2, 34);
  display.display();
}

void showWiFiStatus() {
  if (WiFi.status() == WL_CONNECTED) show("WiFi", "Terhubung");
  else show("WiFi", "Terputus");
}

bool longPress(int pin, unsigned long &pressedAt, bool &handled) {
  if (digitalRead(pin) == HIGH) {
    pressedAt = millis();
    handled = false;
    return false;
  }

  if (handled || millis() - pressedAt < LONG_PRESS_TIME) return false;

  handled = true;
  return true;
}

bool shortPress(int pin, bool &lastState) {
  bool state = digitalRead(pin);
  bool pressed = lastState == HIGH && state == LOW;
  lastState = state;
  return pressed;
}

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void savePeers() {
  prefs.putUChar("count", peerCount);
  prefs.putBytes("macs", peers, peerCount * 6);
}

void loadPeers() {
  peerCount = prefs.getUChar("count", 0);
  if (peerCount > MAX_PEERS) peerCount = 0;
  prefs.getBytes("macs", peers, peerCount * 6);

  for (int i = 0; i < peerCount; i++) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, peers[i], 6);
    esp_now_add_peer(&peer);
  }

  Serial.printf("Peer di-load: %d\n", peerCount);
}

void resetPeers() {
  for (int i = 0; i < peerCount; i++) {
    esp_now_del_peer(peers[i]);
  }
  peerCount = 0;
  savePeers();
  Serial.println("Semua peer dihapus.");
}

void printStatus() {
  Serial.printf("Peer terhubung: %d/%d\n", peerCount, MAX_PEERS);
  for (int i = 0; i < peerCount; i++) {
    Serial.printf("%02X:%02X:%02X:%02X:%02X:%02X\n",
                  peers[i][0], peers[i][1], peers[i][2], peers[i][3], peers[i][4], peers[i][5]);
  }
}

void removePeer(const uint8_t *mac) {
  for (int i = 0; i < peerCount; i++) {
    if (memcmp(peers[i], mac, 6) != 0) continue;

    esp_now_del_peer(mac);
    for (int j = i; j < peerCount - 1; j++) {
      memcpy(peers[j], peers[j + 1], 6);
    }
    peerCount--;
    savePeers();

    Serial.printf("Peer terputus: %02X:%02X:%02X:%02X:%02X:%02X (%d/%d)\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], peerCount, MAX_PEERS);
    return;
  }
}

bool alreadyQueued(const uint8_t *mac) {
  for (int i = 0; i < queueCount; i++) {
    if (memcmp(queueMac[i], mac, 6) == 0) return true;
  }
  return false;
}

bool alreadySkipped(const uint8_t *mac) {
  for (int i = 0; i < skippedCount; i++) {
    if (memcmp(skippedMac[i], mac, 6) == 0) return true;
  }
  return false;
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (len == 1 && data[0] == MSG_DISCONNECT) {
    removePeer(mac);
    return;
  }

  if (len == 1 && data[0] == MSG_PING) {
    uint8_t pong = MSG_PONG;
    esp_now_send(mac, &pong, sizeof(pong));
    return;
  }

  if (!listening) return;

  if (len == 4 && memcmp(data, TAG, 4) == 0) {
    if (esp_now_is_peer_exist(mac) || alreadyQueued(mac) || alreadySkipped(mac)) return;
    if ((awaitingResponse || confirming) && memcmp(mac, currentMac, 6) == 0) return;
    if (peerCount >= MAX_PEERS || queueCount >= MAX_QUEUE) return;

    memcpy(queueMac[queueCount], mac, 6);
    queueCount++;
    listenStartedAt = millis();

    Serial.printf("Kandidat terdeteksi: %02X:%02X:%02X:%02X:%02X:%02X, masuk antrian.\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return;
  }

  if (len == sizeof(AuthMessage) && awaitingResponse && memcmp(mac, currentMac, 6) == 0) {
    const AuthMessage *reply = (const AuthMessage*)data;
    if (reply->nonce != currentNonce) return;

    uint8_t expectedProof[3];
    computeProof(currentNonce, expectedProof);

    if (memcmp(reply->proof, expectedProof, 3) == 0) {
      memcpy(peers[peerCount], currentMac, 6);
      peerCount++;
      savePeers();
      bondResult = 1;

      Serial.printf("Valid, bonding permanen: %02X:%02X:%02X:%02X:%02X:%02X (%d/%d)\n",
                    currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5],
                    peerCount, MAX_PEERS);
    } else {
      esp_now_del_peer(currentMac);
      bondResult = 2;
      Serial.printf("Tidak valid, ditolak: %02X:%02X:%02X:%02X:%02X:%02X\n",
                    currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5]);
    }

    awaitingResponse = false;
    listenStartedAt = millis();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_WIFI_PIN, INPUT_PULLUP);
  pinMode(BUTTON_DOORLOCK_PIN, INPUT_PULLUP);

  Wire.begin(4, 5);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  show("Gateway", "Siap");

  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  WiFi.begin();
  WiFi.waitForConnectResult(10000);

  esp_now_init();
  esp_now_register_recv_cb(onReceive);

  prefs.begin("gateway", false);
  loadPeers();

  showWiFiStatus();
}

void loop() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Reset") {
      resetPeers();
    } else if (command == "Status") {
      printStatus();
    }
  }

  bool wifiLong = longPress(BUTTON_WIFI_PIN, wifiPressedAt, wifiHandled);
  bool doorlockLong = longPress(BUTTON_DOORLOCK_PIN, doorlockPressedAt, doorlockHandled);
  bool yesPressed = shortPress(BUTTON_WIFI_PIN, lastWifiState);
  bool noPressed = shortPress(BUTTON_DOORLOCK_PIN, lastDoorlockState);

  if (wifiLong && !listening) {
    show("Pairing", "WiFi");
    wm.setConfigPortalTimeout(120);
    wm.startConfigPortal("ISK-Gateway");
    showWiFiStatus();
  }

  if (doorlockLong && !listening) {
    listening = true;
    listenStartedAt = millis();
    queueCount = 0;
    skippedCount = 0;
    candidateNumber = 0;
    confirming = false;
    awaitingResponse = false;
    show("Pairing", "Doorlock");
    Serial.println("Masuk mode listen...");
  }

  if (bondResult != 0) {
    show(candidateLabel, bondResult == 1 ? "Terdaftar" : "Ditolak");
    bondResult = 0;
    delay(1000);
    show("Pairing", "Doorlock");
  }

  if (awaitingResponse && millis() - challengeSentAt > CHALLENGE_TIMEOUT) {
    esp_now_del_peer(currentMac);
    Serial.printf("Timeout menunggu balasan dari %02X:%02X:%02X:%02X:%02X:%02X.\n",
                  currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5]);
    awaitingResponse = false;
    listenStartedAt = millis();
    show("Pairing", "Doorlock");
  }

  if (listening && !awaitingResponse && !confirming && queueCount > 0 && peerCount < MAX_PEERS) {
    memcpy(currentMac, queueMac[0], 6);
    for (int i = 1; i < queueCount; i++) {
      memcpy(queueMac[i - 1], queueMac[i], 6);
    }
    queueCount--;

    candidateNumber++;
    snprintf(candidateLabel, sizeof(candidateLabel), "Doorlock %d", candidateNumber);
    confirming = true;
    listenStartedAt = millis();
    show(candidateLabel, "Connect?");

    Serial.printf("%s: %02X:%02X:%02X:%02X:%02X:%02X, tunggu konfirmasi.\n", candidateLabel,
                  currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5]);
  }

  if (confirming && noPressed) {
    confirming = false;
    if (skippedCount < MAX_QUEUE) {
      memcpy(skippedMac[skippedCount], currentMac, 6);
      skippedCount++;
    }
    listenStartedAt = millis();

    show(candidateLabel, "Dilewati");
    Serial.printf("%s dilewati.\n", candidateLabel);
    delay(1000);
    show("Pairing", "Doorlock");
  }

  if (confirming && yesPressed) {
    confirming = false;
    show(candidateLabel, "Verifikasi");

    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, currentMac, 6);
    esp_now_add_peer(&peer);

    currentNonce = esp_random();
    AuthMessage challenge = { currentNonce, {0, 0, 0} };
    esp_now_send(currentMac, (uint8_t*)&challenge, sizeof(challenge));

    challengeSentAt = millis();
    awaitingResponse = true;

    Serial.printf("Challenge dikirim ke %02X:%02X:%02X:%02X:%02X:%02X (nonce=0x%08X).\n",
                  currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5],
                  currentNonce);
  }

  if (listening && millis() - listenStartedAt > PAIRING_TIMEOUT) {
    listening = false;
    confirming = false;
    queueCount = 0;
    if (awaitingResponse) {
      esp_now_del_peer(currentMac);
      awaitingResponse = false;
    }
    Serial.println("Timeout, kembali ke mode idle.");
    showWiFiStatus();
  }
}

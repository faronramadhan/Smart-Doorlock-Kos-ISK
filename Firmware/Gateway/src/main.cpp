#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <Preferences.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>

#define WIFI_CHANNEL 1

#define MAX_ROOMS 20
#define MAX_QUEUE 20
#define MAX_EVENTS 16
#define MSG_DISCONNECT 2
#define CHALLENGE_TIMEOUT 2000

#define DOOR_MSG_HEADER 0xD0
#define DOOR_STATUS_HEADER 0xD1
#define CMD_RFID_ALLOW 0x03
#define CMD_RFID_BLOCK 0x04
#define EVT_LOCKED 0x11
#define EVT_UNLOCKED 0x12
#define EVT_BATTERY_SHUTDOWN 0x13
#define EVT_RFID_REJECTED 0x14

#define BUTTON_YES_PIN 20
#define BUTTON_PAIRING_PIN 21
#define LONG_PRESS_MS 5000
#define PAIRING_WINDOW_MS 60000
#define DETECT_WINDOW_MS 3000
#define RESULT_SHOW_MS 1500

#define OLED_SDA 4
#define OLED_SCL 5

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

typedef struct {
  uint8_t activity;
  bool connected;
  int battery;
} DoorState;

typedef struct {
  uint8_t mac[6];
  uint8_t data[8];
  int len;
  int rssi;
} RxEvent;

enum State { IDLE, DETECTING, CONFIRMING, ENCRYPTING };

Preferences prefs;
Adafruit_SSD1306 display(128, 64, &Wire, -1);
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

RxEvent events[MAX_EVENTS];
int eventHead = 0;
int eventTail = 0;

int peerCount = 0;
uint8_t doorlockMac[MAX_ROOMS][6];
bool rfidAccess[MAX_ROOMS];
DoorState doors[MAX_ROOMS];

State state = IDLE;
unsigned long pairingStartedAt = 0;
unsigned long lastDetectedAt = 0;
int shownCount = -1;
int candidateNumber = 0;

uint8_t queueMac[MAX_QUEUE][6];
int queueCount = 0;
uint8_t skippedMac[MAX_QUEUE][6];
int skippedCount = 0;

uint8_t currentMac[6];
uint32_t currentNonce = 0;
unsigned long challengeSentAt = 0;

unsigned long buttonPressedAt = 0;
bool buttonHandled = false;
bool lastYesState = HIGH;
bool lastNoState = HIGH;

volatile int lastRssi = 0;
uint8_t lastRssiMac[6];

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void printCenter(const char *text, int y) {
  int size = strlen(text) * 12 <= 128 ? 2 : 1;
  display.setTextSize(size);
  display.setCursor((128 - strlen(text) * 6 * size) / 2, y);
  display.print(text);
}

void show(const char *line1, const char *line2) {
  display.clearDisplay();
  printCenter(line1, 14);
  printCenter(line2, 34);
  display.display();
}

void showIdle() {
  char text[8];
  snprintf(text, sizeof(text), "%d/%d", peerCount, MAX_ROOMS);
  show("Doorlock", text);
  shownCount = peerCount;
}

void showResult(const char *result) {
  char text[16];
  snprintf(text, sizeof(text), "Doorlock %d", candidateNumber);
  show(text, result);
  delay(RESULT_SHOW_MS);
}

bool slotEmpty(int i) {
  static const uint8_t empty[6] = { 0 };
  return memcmp(doorlockMac[i], empty, 6) == 0;
}

int freeSlot() {
  for (int i = 0; i < MAX_ROOMS; i++) {
    if (slotEmpty(i)) return i;
  }
  return -1;
}

int slotOf(const uint8_t *mac) {
  for (int i = 0; i < MAX_ROOMS; i++) {
    if (!slotEmpty(i) && memcmp(doorlockMac[i], mac, 6) == 0) return i;
  }
  return -1;
}

bool inList(uint8_t list[][6], int count, const uint8_t *mac) {
  for (int i = 0; i < count; i++) {
    if (memcmp(list[i], mac, 6) == 0) return true;
  }
  return false;
}

const char *activityName(uint8_t activity) {
  switch (activity) {
    case EVT_LOCKED: return "locked";
    case EVT_UNLOCKED: return "unlocked";
    case EVT_BATTERY_SHUTDOWN: return "battery_shutdown";
    case EVT_RFID_REJECTED: return "rfid_rejected";
    default: return "-";
  }
}

void savePeers() {
  prefs.putBytes("slots", doorlockMac, sizeof(doorlockMac));
  prefs.putBytes("rfid", rfidAccess, sizeof(rfidAccess));
  prefs.putBytes("doors", doors, sizeof(doors));
}

void loadPeers() {
  memset(doorlockMac, 0, sizeof(doorlockMac));
  prefs.getBytes("slots", doorlockMac, sizeof(doorlockMac));
  bool hasRfid = prefs.getBytes("rfid", rfidAccess, sizeof(rfidAccess)) == sizeof(rfidAccess);
  bool hasDoors = prefs.getBytes("doors", doors, sizeof(doors)) == sizeof(doors);

  for (int i = 0; i < MAX_ROOMS; i++) {
    if (!hasRfid) rfidAccess[i] = true;
    if (!hasDoors || slotEmpty(i)) doors[i] = { 0, false, -1 };
    if (slotEmpty(i)) continue;

    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, doorlockMac[i], 6);
    esp_now_add_peer(&peer);
    peerCount++;
  }
}

void printStatus() {
  Serial.printf("Doorlock terhubung: %d/%d\n", peerCount, MAX_ROOMS);
  for (int i = 0; i < MAX_ROOMS; i++) {
    if (slotEmpty(i)) continue;
    char battery[8] = "-";
    if (doors[i].battery >= 0) snprintf(battery, sizeof(battery), "%d%%", doors[i].battery);
    Serial.printf("Doorlock %d: %s, %s, %s, baterai %s (%02X:%02X:%02X:%02X:%02X:%02X)\n", i + 1,
                  rfidAccess[i] ? "ALLOW" : "BLOCK", activityName(doors[i].activity),
                  doors[i].connected ? "connected" : "disconnected", battery,
                  doorlockMac[i][0], doorlockMac[i][1], doorlockMac[i][2], doorlockMac[i][3], doorlockMac[i][4], doorlockMac[i][5]);
  }
}

void setRfidAccess(int number, bool allow) {
  if (number < 1 || number > MAX_ROOMS || slotEmpty(number - 1)) {
    Serial.printf("Doorlock %d tidak ada.\n", number);
    return;
  }

  portENTER_CRITICAL(&mux);
  rfidAccess[number - 1] = allow;
  portEXIT_CRITICAL(&mux);
  savePeers();
  Serial.printf("Doorlock %d: %s, dikirim saat Doorlock bangun.\n", number, allow ? "ALLOW" : "BLOCK");
}

void addDoorlock(int slot, int rssi) {
  portENTER_CRITICAL(&mux);
  memcpy(doorlockMac[slot], currentMac, 6);
  rfidAccess[slot] = true;
  portEXIT_CRITICAL(&mux);
  doors[slot] = { 0, true, -1 };
  peerCount++;
  savePeers();

  Serial.printf("Doorlock %d connect: %02X:%02X:%02X:%02X:%02X:%02X (%d/%d, RSSI %d dBm)\n", slot + 1,
                currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5],
                peerCount, MAX_ROOMS, rssi);
}

void removeDoorlock(int slot, int rssi) {
  uint8_t mac[6];
  memcpy(mac, doorlockMac[slot], 6);
  esp_now_del_peer(mac);

  portENTER_CRITICAL(&mux);
  memset(doorlockMac[slot], 0, 6);
  portEXIT_CRITICAL(&mux);
  doors[slot] = { 0, false, -1 };
  peerCount--;
  savePeers();

  Serial.printf("Doorlock %d disconnect: %02X:%02X:%02X:%02X:%02X:%02X (%d/%d, RSSI %d dBm)\n", slot + 1,
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], peerCount, MAX_ROOMS, rssi);
}

void onSniff(void *buf, wifi_promiscuous_pkt_type_t type) {
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t*)buf;
  if (pkt->payload[0] != 0xD0) return;
  memcpy(lastRssiMac, pkt->payload + 10, 6);
  lastRssi = pkt->rx_ctrl.rssi;
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (len > (int)sizeof(RxEvent::data)) return;

  if (len == sizeof(DoorStatusMessage) && data[0] == DOOR_STATUS_HEADER) {
    portENTER_CRITICAL(&mux);
    int slot = slotOf(mac);
    bool allow = slot >= 0 && rfidAccess[slot];
    portEXIT_CRITICAL(&mux);

    if (slot >= 0) {
      DoorMessage reply = { DOOR_MSG_HEADER, (uint8_t)(allow ? CMD_RFID_ALLOW : CMD_RFID_BLOCK) };
      esp_now_send(mac, (uint8_t*)&reply, sizeof(reply));
    }
  }

  int rssi = memcmp(lastRssiMac, mac, 6) == 0 ? lastRssi : 0;

  portENTER_CRITICAL(&mux);
  int next = (eventHead + 1) % MAX_EVENTS;
  if (next != eventTail) {
    memcpy(events[eventHead].mac, mac, 6);
    memcpy(events[eventHead].data, data, len);
    events[eventHead].len = len;
    events[eventHead].rssi = rssi;
    eventHead = next;
  }
  portEXIT_CRITICAL(&mux);
}

bool popEvent(RxEvent &event) {
  bool available = false;
  portENTER_CRITICAL(&mux);
  if (eventTail != eventHead) {
    event = events[eventTail];
    eventTail = (eventTail + 1) % MAX_EVENTS;
    available = true;
  }
  portEXIT_CRITICAL(&mux);
  return available;
}

void startPairing() {
  queueCount = 0;
  skippedCount = 0;
  shownCount = 0;
  pairingStartedAt = millis();
  state = DETECTING;
  show("Pairing", "Doorlock");
}

void stopPairing() {
  queueCount = 0;
  state = IDLE;
  showIdle();
}

void askCandidate() {
  candidateNumber = freeSlot() + 1;
  char text[16];
  snprintf(text, sizeof(text), "Doorlock %d?", candidateNumber);
  show("Connect", text);
  state = CONFIRMING;
}

void nextCandidate() {
  for (int i = 1; i < queueCount; i++) {
    memcpy(queueMac[i - 1], queueMac[i], 6);
  }
  queueCount--;

  if (queueCount > 0) askCandidate();
  else stopPairing();
}

void skipCandidate() {
  if (skippedCount < MAX_QUEUE) {
    memcpy(skippedMac[skippedCount], queueMac[0], 6);
    skippedCount++;
  }
}

void sendChallenge() {
  char text[16];
  snprintf(text, sizeof(text), "Doorlock %d", candidateNumber);
  show("Enkripsi", text);

  memcpy(currentMac, queueMac[0], 6);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, currentMac, 6);
  esp_now_add_peer(&peer);

  currentNonce = esp_random();
  AuthMessage challenge = { currentNonce, {0, 0, 0} };
  challengeSentAt = millis();
  esp_now_send(currentMac, (uint8_t*)&challenge, sizeof(challenge));
  state = ENCRYPTING;
}

void encryptionFailed() {
  esp_now_del_peer(currentMac);
  skipCandidate();
  show("Gagal", "Enkripsi");
  delay(RESULT_SHOW_MS);
  nextCandidate();
}

void handleEvent(const RxEvent &event) {
  const uint8_t *mac = event.mac;
  const uint8_t *data = event.data;
  int len = event.len;
  int slot = slotOf(mac);

  if (len == 1 && data[0] == MSG_DISCONNECT) {
    if (slot >= 0) removeDoorlock(slot, event.rssi);
    return;
  }

  if (slot >= 0 && len == sizeof(DoorMessage) && data[0] == DOOR_MSG_HEADER) {
    uint8_t code = data[1];
    if (code != EVT_LOCKED && code != EVT_UNLOCKED && code != EVT_BATTERY_SHUTDOWN && code != EVT_RFID_REJECTED) return;

    doors[slot].activity = code;
    doors[slot].connected = code != EVT_BATTERY_SHUTDOWN;
    savePeers();
    Serial.printf("Doorlock %d: %s (RSSI %d dBm)\n", slot + 1, activityName(code), event.rssi);
    return;
  }

  if (slot >= 0 && len == sizeof(DoorStatusMessage) && data[0] == DOOR_STATUS_HEADER) {
    const DoorStatusMessage *msg = (const DoorStatusMessage*)data;
    doors[slot].activity = msg->unlocked ? EVT_UNLOCKED : EVT_LOCKED;
    doors[slot].connected = true;
    doors[slot].battery = msg->battery;
    savePeers();
    Serial.printf("Doorlock %d: %s, baterai %d%%, dibalas %s (RSSI %d dBm)\n", slot + 1,
                  activityName(doors[slot].activity), msg->battery, rfidAccess[slot] ? "ALLOW" : "BLOCK", event.rssi);
    return;
  }

  if (state == IDLE) return;

  if (len == sizeof(TAG) && memcmp(data, TAG, sizeof(TAG)) == 0) {
    if (slot >= 0 || inList(queueMac, queueCount, mac) || inList(skippedMac, skippedCount, mac)) return;
    if (peerCount + queueCount >= MAX_ROOMS || queueCount >= MAX_QUEUE) return;

    memcpy(queueMac[queueCount], mac, 6);
    queueCount++;
    lastDetectedAt = millis();
    return;
  }

  if (len == sizeof(AuthMessage) && state == ENCRYPTING && memcmp(mac, currentMac, 6) == 0) {
    const AuthMessage *reply = (const AuthMessage*)data;
    if (reply->nonce != currentNonce) return;

    uint8_t expectedProof[3];
    computeProof(currentNonce, expectedProof);
    int freeIndex = freeSlot();

    if (memcmp(reply->proof, expectedProof, 3) == 0 && freeIndex >= 0) {
      addDoorlock(freeIndex, event.rssi);
      showResult("Connect!");
      nextCandidate();
    } else {
      encryptionFailed();
    }
  }
}

bool longPress(int pin) {
  if (digitalRead(pin) == HIGH) {
    buttonPressedAt = millis();
    buttonHandled = false;
    return false;
  }

  if (buttonHandled || millis() - buttonPressedAt < LONG_PRESS_MS) return false;
  buttonHandled = true;
  return true;
}

bool shortPress(int pin, bool &lastState) {
  bool level = digitalRead(pin);
  bool pressed = lastState == HIGH && level == LOW;
  lastState = level;
  return pressed;
}

void handleButtons() {
  bool pairingHeld = longPress(BUTTON_PAIRING_PIN);
  bool yesPressed = shortPress(BUTTON_YES_PIN, lastYesState);
  bool noPressed = shortPress(BUTTON_PAIRING_PIN, lastNoState);

  if (state == IDLE && pairingHeld) {
    startPairing();
  } else if (state == CONFIRMING && yesPressed) {
    sendChallenge();
  } else if (state == CONFIRMING && noPressed) {
    buttonHandled = true;
    skipCandidate();
    showResult("Dilewati");
    nextCandidate();
  }
}

void handleSerial() {
  if (!Serial.available()) return;

  String command = Serial.readStringUntil('\n');
  command.trim();

  int number;
  char action[8];
  if (command == "Status") {
    printStatus();
  } else if (sscanf(command.c_str(), "Doorlock %d: %7s", &number, action) == 2 &&
             (strcmp(action, "BLOCK") == 0 || strcmp(action, "ALLOW") == 0)) {
    setRfidAccess(number, strcmp(action, "ALLOW") == 0);
  } else {
    Serial.println("Perintah: Status / Doorlock {n}: BLOCK / Doorlock {n}: ALLOW");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(BUTTON_YES_PIN, INPUT_PULLUP);
  pinMode(BUTTON_PAIRING_PIN, INPUT_PULLUP);

  Wire.begin(OLED_SDA, OLED_SCL);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);

  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_now_init();

  prefs.begin("gateway", false);
  loadPeers();

  esp_now_register_recv_cb(onReceive);
  wifi_promiscuous_filter_t filter = { WIFI_PROMIS_FILTER_MASK_MGMT };
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(onSniff);
  esp_wifi_set_promiscuous(true);

  showIdle();
}

void loop() {
  handleSerial();

  RxEvent event;
  while (popEvent(event)) handleEvent(event);

  handleButtons();

  switch (state) {
    case IDLE:
      if (shownCount != peerCount) showIdle();
      break;

    case DETECTING:
      if (queueCount != shownCount) {
        char text[16];
        snprintf(text, sizeof(text), "%d Doorlock", queueCount);
        show("Terdeteksi", text);
        shownCount = queueCount;
      }

      if (queueCount == 0 && millis() - pairingStartedAt > PAIRING_WINDOW_MS) {
        show("Pairing", "Timeout");
        delay(RESULT_SHOW_MS);
        stopPairing();
      } else if (queueCount > 0 && millis() - lastDetectedAt > DETECT_WINDOW_MS) {
        askCandidate();
      }
      break;

    case CONFIRMING:
      break;

    case ENCRYPTING:
      if (millis() - challengeSentAt > CHALLENGE_TIMEOUT) encryptionFailed();
      break;
  }
}

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_system.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <Firebase_ESP_Client.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>
#include <WiFiManager.h>

/* ===== KONFIGURASI ===== */
// DATABASE_SECRET ada di include/secrets.h (tidak ikut di-commit, lihat secrets.example.h).
// SSID & password WiFi tidak di-hardcode: diisi dari HP lewat hotspot ISK-Gateway (tahan button 1 selama 5 detik).
#include "secrets.h"

#define DATABASE_URL     "https://isk-house-default-rtdb.asia-southeast1.firebasedatabase.app"

// Path node gateway di database. Isi untuk gateway yang dibuat manual dari dashboard (tanpa gatewayMac);
// kosongkan ("") supaya gateway mencari sendiri lewat gatewayMac hasil klasifikasi admin.
#define GATEWAY_PATH     "locations/ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja/Lantai 1/Gateway 1"

#define BUTTON_WIFI_PIN     20      // button 1: tahan = pairing WiFi, tekan = "ya" saat konfirmasi doorlock
#define BUTTON_DOORLOCK_PIN 21      // button 2: tahan = pairing doorlock, tekan = "lewati" saat konfirmasi doorlock
#define LONG_PRESS_TIME     5000
#define PORTAL_TIMEOUT_S    120     // hotspot ISK-Gateway otomatis tutup setelah 2 menit
#define WIFI_CONNECT_MS     10000   // batas tunggu WiFi tersimpan saat boot, setelah itu gateway tetap jalan

#define MAX_ROOMS           20      // sama dengan MAX_ROOMS di Website/main.js
#define DISCOVERY_RETRY_MS  15000   // jeda cek ulang apakah gateway sudah diklasifikasikan admin
#define PAIRING_WINDOW_MS   60000   // mode pairing berhenti setelah 60 detik tanpa aktivitas
#define BEACON_INTERVAL_MS  100     // beacon pairing supaya doorlock bisa menemukan channel WiFi gateway
#define CHALLENGE_TIMEOUT   2000
#define MAX_QUEUE           16
#define MAX_EVENTS          8

#define HEARTBEAT_INTERVAL_MS 5000   // doorlock mengirim status (baterai + posisi kunci) tiap 5 detik
#define HEARTBEAT_TIMEOUT_MS  15000  // 3x status tidak datang -> doorlock dianggap terputus
#define BATTERY_LOW           20     // % -> notifikasi baterai lemah
#define BATTERY_EMPTY         5      // % -> kalau terputus di bawah angka ini, penyebabnya dianggap baterai habis
#define COMMAND_GRACE_MS      3000   // posisi kunci dari heartbeat diabaikan sesaat setelah perintah dikirim
#define GATEWAY_HEARTBEAT_MS  30000  // gateway melapor "masih hidup" ke Firebase tiap 30 detik (dibaca website)
#define SIM_AUTO_LOCK_MS      5000   // doorlock simulasi mengunci sendiri 5 detik setelah dibuka kartu RFID

// Doorlock dummy: disimulasikan otomatis sejak gateway menyala (tanpa perintah "sim"), mengirim data baterai
// tiap HEARTBEAT_INTERVAL_MS. Nilai baterai diinput manual lewat Serial Monitor ("battery 101 75").
// Kosongkan ("") untuk mematikan.
#define DUMMY_ROOMS           "101"  // nomor kamar, pisahkan dengan koma, mis. "101,102"
#define DUMMY_BATTERY         100    // baterai awal doorlock dummy (%)

/* Struktur database (history tidak disimpan di Firebase, hanya di localStorage website):
   locations/{cabang}/{lantai}/{gateway}/gatewayMac (opsional)
   locations/{cabang}/{lantai}/{gateway}/Kamar {n}: { tenant, rfidAccess, status, unlockedAt, doorlockMac,
                                                       battery, connection, connectionReason, connectionUpdatedAt }
   locations/{cabang}/{lantai}/{gateway}/gatewayStatus: { lastSeen, lastRestartReason, lastRestartAt,
                                                          lastDisconnectReason, lastDisconnectSeconds, lastReconnectAt }
   pendingGateways/{macGateway}: { pairedAt }
   pendingDevices/{macDoorlock}: { gatewayMac, pairedAt } */

/* ===== ESP-NOW: pairing HMAC (lihat Document/Documentation/HMAC.md) ===== */
const uint8_t broadcastAddress[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 }; // Kos ISK, Doorlock, HW v0, SW v0
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

/* Pesan 1 byte */
#define MSG_DISCONNECT 2  // doorlock -> gateway: memutus pairing (mau pairing ke gateway lain)
#define MSG_BEACON     5  // gateway -> broadcast: mode pairing aktif di channel ini

/* Pesan setelah pairing (2 byte). Belum terenkripsi — PMK/LMK belum diterapkan, lihat HMAC.md bagian 6. */
#define DOOR_MSG_HEADER 0xD0
enum : uint8_t {
  CMD_LOCK       = 0x01,  // gateway -> doorlock
  CMD_UNLOCK     = 0x02,
  CMD_RFID_ALLOW = 0x03,
  CMD_RFID_BLOCK = 0x04,
  EVT_LOCKED     = 0x11,  // doorlock -> gateway
  EVT_UNLOCKED   = 0x12,
  EVT_BATTERY_SHUTDOWN = 0x13,  // doorlock pamit mati karena baterai habis
  EVT_PAIRED     = 0xF0,  // internal: hasil pairing HMAC, dari callback ke loop()
  EVT_REJECTED   = 0xF1,
  EVT_HEARTBEAT  = 0xF2,  // internal: DoorStatusMessage diterima
  EVT_DISCONNECT = 0xF3   // internal: MSG_DISCONNECT diterima
};

typedef struct {
  uint8_t header;
  uint8_t code;
} DoorMessage;

/* Status doorlock -> gateway (3 byte), dikirim tiap doorlock bangun. Gateway langsung membalas
   CMD_RFID_ALLOW / CMD_RFID_BLOCK supaya doorlock tahu kartu sedang diblokir atau tidak. */
#define DOOR_STATUS_HEADER 0xD1
typedef struct {
  uint8_t header;
  uint8_t battery;   // 0-100 %
  uint8_t unlocked;  // 1 = terbuka, 0 = terkunci
} DoorStatusMessage;

typedef struct {
  String key;          // "Kamar 101"
  String doorlockMac;  // kosong kalau kamar belum terhubung ke doorlock
  uint8_t mac[6];
  bool hasMac = false;
  String status;       // "locked" / "unlocked"
  bool rfidAccess = true;

  // Status doorlock dari heartbeat — hanya di RAM, dibawa terus saat refreshRooms()
  bool tracked = false;           // koneksinya dipantau (sudah pernah kirim heartbeat sejak gateway menyala)
  bool online = false;
  int battery = -1;               // -1 = belum diketahui
  String connectionReason;
  unsigned long lastHeartbeatAt = 0;
  unsigned long lastCommandAt = 0;

  // Simulasi doorlock lewat Serial Monitor (perintah "sim")
  bool simActive = false;
  bool simSignal = true;
  int simBattery = DUMMY_BATTERY; // hanya berubah lewat perintah "battery"
  unsigned long simLastBeatAt = 0;
  unsigned long simRelockAt = 0;  // jadwal kunci otomatis setelah dibuka kartu RFID
} Room;

typedef struct {
  uint8_t mac[6];
  uint8_t code;
  uint8_t battery;
  uint8_t unlocked;
} PendingEvent;

/* ===== STATE ===== */
FirebaseData fbdo;    // request biasa (get/set/update)
FirebaseData stream;  // koneksi stream ke node gateway
FirebaseAuth fbAuth;  // tidak diisi — gateway login pakai database secret, bukan email
FirebaseConfig fbConfig;
Preferences prefs;
Adafruit_SSD1306 display(128, 64, &Wire, -1);
WiFiManager wm;

const bool useFixedPath = sizeof(GATEWAY_PATH) > 1;

String gatewayMac;
String gatewayPath;  // "locations/{cabang}/{lantai}/{gateway}", kosong = belum diklasifikasikan admin
bool pendingRegistered = false;
bool streaming = false;
bool roomsDirty = false;
unsigned long lastDiscoveryAt = 0;
unsigned long lastStreamErrorAt = 0;
unsigned long lastGatewayBeatAt = 0;
bool restartReported = false;

// Diisi event WiFi (task terpisah) saat gateway kehilangan WiFi, dilaporkan ke Firebase setelah tersambung lagi
volatile unsigned long wifiDropAt = 0;
volatile uint8_t wifiDropReason = 0;
bool dropWatchStarted = false;
bool shownConnected = false;

Room rooms[MAX_ROOMS];
int roomCount = 0;

// Salinan MAC doorlock yang kartunya diblokir, dibaca callback ESP-NOW untuk membalas status (dilindungi mux)
uint8_t blockedMac[MAX_ROOMS][6];
int blockedCount = 0;

// Button
unsigned long wifiPressedAt = 0;
unsigned long doorlockPressedAt = 0;
bool wifiHandled = false;
bool doorlockHandled = false;
bool lastWifiState = HIGH;
bool lastDoorlockState = HIGH;

// Pairing — sebagian state disentuh callback ESP-NOW (task WiFi), jadi dilindungi mux
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
volatile bool pairingActive = false;
unsigned long pairingStartedAt = 0;
unsigned long lastBeaconAt = 0;
uint8_t queueMac[MAX_QUEUE][6];
volatile int queueCount = 0;
uint8_t skippedMac[MAX_QUEUE][6];  // doorlock yang dilewati tidak ditanyakan lagi di sesi pairing yang sama
volatile int skippedCount = 0;
uint8_t currentMac[6];
volatile uint32_t currentNonce = 0;
unsigned long challengeSentAt = 0;
volatile bool awaitingResponse = false;
volatile bool confirming = false;   // menunggu jawaban button: connect ke doorlock ini atau tidak
volatile int bondResult = 0;        // 1 = valid, 2 = ditolak — ditampilkan di OLED oleh loop()
int candidateNumber = 0;
char candidateLabel[12];

// Antrian kejadian dari callback ESP-NOW ke loop() (Firebase tidak boleh dipanggil dari callback)
PendingEvent events[MAX_EVENTS];
volatile int eventHead = 0;
volatile int eventTail = 0;

// RSSI paket ESP-NOW terakhir, untuk log activity (dibaca Test/Firmware/7. Kecepatan Pairing dan Unlock)
volatile int lastRssi = 0;
uint8_t lastRssiMac[6];

/* ===== OLED ===== */
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
  shownConnected = WiFi.status() == WL_CONNECTED;
  if (shownConnected) show("WiFi", "Terhubung");
  else show("WiFi", "Terputus");
}

/* ===== BUTTON ===== */
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

/* ===== HELPER ===== */
String macToString(const uint8_t *mac) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

bool parseMac(const String &text, uint8_t *out) {
  unsigned int b[6];
  if (sscanf(text.c_str(), "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) != 6) return false;
  for (int i = 0; i < 6; i++) out[i] = (uint8_t)b[i];
  return true;
}

// Library Firebase tidak meng-encode path, padahal key di database berisi spasi & koma
// (mis. "ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja") -> request rusak tanpa ini
String dbPath(const String &path) {
  String out;
  for (size_t i = 0; i < path.length(); i++) {
    char c = path[i];
    if (isalnum((unsigned char)c) || c == '/' || c == '-' || c == '_' || c == '.' || c == '~' || c == ':') {
      out += c;
    } else {
      char buf[4];
      snprintf(buf, sizeof(buf), "%%%02X", (uint8_t)c);
      out += buf;
    }
  }
  return out;
}

void printFirebaseError(const char *context) {
  Serial.printf("[FIREBASE] %s gagal: %s\n", context, fbdo.errorReason().c_str());
}

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void ensurePeer(const uint8_t *mac) {
  if (esp_now_is_peer_exist(mac)) return;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  peer.channel = 0;  // ikut channel WiFi router yang sedang terhubung
  esp_now_add_peer(&peer);
}

Room *findRoomByKey(const String &key) {
  for (int i = 0; i < roomCount; i++) {
    if (rooms[i].key == key) return &rooms[i];
  }
  return nullptr;
}

Room *findRoomByDoorlock(const String &mac) {
  for (int i = 0; i < roomCount; i++) {
    if (rooms[i].hasMac && rooms[i].doorlockMac.equalsIgnoreCase(mac)) return &rooms[i];
  }
  return nullptr;
}

/* ===== ANTRIAN KEJADIAN ===== */
void pushEvent(const uint8_t *mac, uint8_t code, uint8_t battery = 0, uint8_t unlocked = 0) {
  portENTER_CRITICAL(&mux);
  int next = (eventHead + 1) % MAX_EVENTS;
  if (next != eventTail) {
    memcpy(events[eventHead].mac, mac, 6);
    events[eventHead].code = code;
    events[eventHead].battery = battery;
    events[eventHead].unlocked = unlocked;
    eventHead = next;
  }
  portEXIT_CRITICAL(&mux);
}

bool popEvent(PendingEvent &out) {
  bool available = false;
  portENTER_CRITICAL(&mux);
  if (eventTail != eventHead) {
    out = events[eventTail];
    eventTail = (eventTail + 1) % MAX_EVENTS;
    available = true;
  }
  portEXIT_CRITICAL(&mux);
  return available;
}

/* ===== ESP-NOW: TERIMA DATA ===== */
// ESP-NOW dikirim sebagai action frame (frame control 0xD0), alamat pengirim di byte 10-15 header 802.11
void onSniff(void *buf, wifi_promiscuous_pkt_type_t type) {
  const wifi_promiscuous_pkt_t *pkt = (const wifi_promiscuous_pkt_t*)buf;
  if (pkt->payload[0] != 0xD0) return;
  memcpy(lastRssiMac, pkt->payload + 10, 6);
  lastRssi = pkt->rx_ctrl.rssi;
}

int rssiOf(const uint8_t *mac) {
  return memcmp(lastRssiMac, mac, 6) == 0 ? lastRssi : 0;
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (len == 1 && data[0] == MSG_DISCONNECT) {
    Serial.printf("[ACT] Disconnect dari %s (RSSI %d)\n", macToString(mac).c_str(), rssiOf(mac));
    pushEvent(mac, EVT_DISCONNECT);
    return;
  }

  // Laporan doorlock (buka/kunci). Dicek di loop() apakah MAC-nya memang terpasang di salah satu kamar.
  if (len == sizeof(DoorMessage) && data[0] == DOOR_MSG_HEADER) {
    Serial.printf("[ACT] Event %s dari %s (RSSI %d)\n", data[1] == EVT_UNLOCKED ? "UNLOCKED" : data[1] == EVT_LOCKED ? "LOCKED" : "lain",
                  macToString(mac).c_str(), rssiOf(mac));
    pushEvent(mac, data[1]);
    return;
  }

  // Doorlock bangun: catat status (baterai + posisi kunci) dan langsung balas status blokir kartu RFID
  if (len == sizeof(DoorStatusMessage) && data[0] == DOOR_STATUS_HEADER) {
    const DoorStatusMessage *msg = (const DoorStatusMessage*)data;
    pushEvent(mac, EVT_HEARTBEAT, msg->battery, msg->unlocked);

    bool blocked = false;
    portENTER_CRITICAL(&mux);
    for (int i = 0; i < blockedCount && !blocked; i++) {
      if (memcmp(blockedMac[i], mac, 6) == 0) blocked = true;
    }
    portEXIT_CRITICAL(&mux);

    DoorMessage reply = { DOOR_MSG_HEADER, blocked ? CMD_RFID_BLOCK : CMD_RFID_ALLOW };
    esp_now_send(mac, (uint8_t*)&reply, sizeof(reply));
    Serial.printf("[ACT] Status dari %s baterai %d%% (RSSI %d), balas RFID %s\n", macToString(mac).c_str(),
                  msg->battery, rssiOf(mac), blocked ? "BLOCK" : "ALLOW");
    return;
  }

  if (!pairingActive) return;

  if (len == sizeof(TAG) && memcmp(data, TAG, sizeof(TAG)) == 0) {
    portENTER_CRITICAL(&mux);
    bool skip = ((awaitingResponse || confirming) && memcmp(mac, currentMac, 6) == 0) || queueCount >= MAX_QUEUE;
    for (int i = 0; i < queueCount && !skip; i++) {
      if (memcmp(queueMac[i], mac, 6) == 0) skip = true;
    }
    for (int i = 0; i < skippedCount && !skip; i++) {
      if (memcmp(skippedMac[i], mac, 6) == 0) skip = true;
    }
    if (!skip) {
      memcpy(queueMac[queueCount], mac, 6);
      queueCount++;
      pairingStartedAt = millis();
    }
    portEXIT_CRITICAL(&mux);
    if (!skip) Serial.printf("[ACT] TAG dari %s masuk antrian (RSSI %d)\n", macToString(mac).c_str(), rssiOf(mac));
    return;
  }

  if (len == sizeof(AuthMessage) && awaitingResponse) {
    if (memcmp(mac, currentMac, 6) != 0) return;

    const AuthMessage *reply = (const AuthMessage*)data;
    if (reply->nonce != currentNonce) return;

    uint8_t expectedProof[3];
    computeProof(currentNonce, expectedProof);
    bool valid = memcmp(reply->proof, expectedProof, 3) == 0;
    pushEvent(mac, valid ? EVT_PAIRED : EVT_REJECTED);
    bondResult = valid ? 1 : 2;
    awaitingResponse = false;
    Serial.printf("[ACT] Proof dari %s %s (RSSI %d)\n", macToString(mac).c_str(), valid ? "VALID" : "TIDAK VALID", rssiOf(mac));
  }
}

/* ===== ESP-NOW: PROSES PAIRING (satu kandidat per giliran, dikonfirmasi lewat button) ===== */
void startPairing() {
  if (pairingActive) return;

  portENTER_CRITICAL(&mux);
  queueCount = 0;
  skippedCount = 0;
  portEXIT_CRITICAL(&mux);

  candidateNumber = 0;
  confirming = false;
  awaitingResponse = false;
  pairingStartedAt = millis();
  pairingActive = true;

  show("Pairing", "Doorlock");
  Serial.printf("[PAIRING] Mode pairing aktif (channel WiFi %d), berhenti setelah %d detik tanpa aktivitas.\n",
                WiFi.channel(), PAIRING_WINDOW_MS / 1000);
}

void stopPairing() {
  pairingActive = false;
  confirming = false;
  portENTER_CRITICAL(&mux);
  queueCount = 0;
  portEXIT_CRITICAL(&mux);

  Serial.println("[PAIRING] Mode pairing selesai.");
  showWiFiStatus();
}

// Button 1 saat konfirmasi: kirim challenge HMAC ke kandidat
void acceptCandidate() {
  confirming = false;
  show(candidateLabel, "Verifikasi");

  ensurePeer(currentMac);
  currentNonce = esp_random();
  AuthMessage challenge = { currentNonce, {0, 0, 0} };
  challengeSentAt = millis();
  awaitingResponse = true;
  esp_now_send(currentMac, (uint8_t*)&challenge, sizeof(challenge));

  Serial.printf("[PAIRING] Challenge dikirim ke %s (nonce=0x%08X).\n", macToString(currentMac).c_str(), currentNonce);
}

// Button 2 saat konfirmasi: kandidat dilewati dan tidak ditanyakan lagi di sesi ini
void skipCandidate() {
  confirming = false;
  portENTER_CRITICAL(&mux);
  if (skippedCount < MAX_QUEUE) {
    memcpy(skippedMac[skippedCount], currentMac, 6);
    skippedCount++;
  }
  portEXIT_CRITICAL(&mux);
  pairingStartedAt = millis();

  show(candidateLabel, "Dilewati");
  Serial.printf("[PAIRING] %s (%s) dilewati.\n", candidateLabel, macToString(currentMac).c_str());
  delay(1000);
  show("Pairing", "Doorlock");
}

void processPairing() {
  if (!pairingActive) return;

  // Doorlock berpindah-pindah channel sampai menangkap beacon ini, lalu berhenti di channel gateway
  if (millis() - lastBeaconAt >= BEACON_INTERVAL_MS) {
    uint8_t beacon = MSG_BEACON;
    esp_now_send(broadcastAddress, &beacon, sizeof(beacon));
    lastBeaconAt = millis();
  }

  if (awaitingResponse && millis() - challengeSentAt > CHALLENGE_TIMEOUT) {
    Serial.printf("[PAIRING] Timeout menunggu balasan dari %s.\n", macToString(currentMac).c_str());
    if (!findRoomByDoorlock(macToString(currentMac))) esp_now_del_peer(currentMac);
    awaitingResponse = false;
    pairingStartedAt = millis();
    show("Pairing", "Doorlock");
  }

  if (!awaitingResponse && millis() - pairingStartedAt > PAIRING_WINDOW_MS) {
    stopPairing();
    return;
  }

  if (awaitingResponse || confirming || queueCount == 0) return;

  portENTER_CRITICAL(&mux);
  memcpy(currentMac, queueMac[0], 6);
  for (int i = 1; i < queueCount; i++) memcpy(queueMac[i - 1], queueMac[i], 6);
  queueCount--;
  portEXIT_CRITICAL(&mux);

  candidateNumber++;
  snprintf(candidateLabel, sizeof(candidateLabel), "Doorlock %d", candidateNumber);
  confirming = true;
  pairingStartedAt = millis();
  show(candidateLabel, "Connect?");

  Serial.printf("[PAIRING] %s: %s, tekan button 1 = connect, button 2 = lewati.\n",
                candidateLabel, macToString(currentMac).c_str());
}

// Hasil verifikasi HMAC dari callback, ditampilkan di OLED
void showPairingResult() {
  if (bondResult == 0) return;

  show(candidateLabel, bondResult == 1 ? "Terdaftar" : "Ditolak");
  bondResult = 0;
  pairingStartedAt = millis();
  delay(1000);
  if (pairingActive) show("Pairing", "Doorlock");
}

/* ===== WIFI ===== */
// Hotspot ISK-Gateway untuk input SSID & password dari HP, tersimpan otomatis di flash
void startWiFiPortal() {
  show("Pairing", "WiFi");
  Serial.printf("[WIFI] Hotspot ISK-Gateway aktif %d detik, buka 192.168.4.1 dari HP.\n", PORTAL_TIMEOUT_S);

  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  wm.startConfigPortal("ISK-Gateway");

  Serial.printf("[WIFI] Hotspot ditutup, WiFi %s.\n", WiFi.status() == WL_CONNECTED ? "terhubung" : "belum terhubung");
  showWiFiStatus();
}

void handleButtons() {
  bool wifiLong = longPress(BUTTON_WIFI_PIN, wifiPressedAt, wifiHandled);
  bool doorlockLong = longPress(BUTTON_DOORLOCK_PIN, doorlockPressedAt, doorlockHandled);
  bool yesPressed = shortPress(BUTTON_WIFI_PIN, lastWifiState);
  bool noPressed = shortPress(BUTTON_DOORLOCK_PIN, lastDoorlockState);

  if (confirming && yesPressed) acceptCandidate();
  else if (confirming && noPressed) skipCandidate();

  if (pairingActive) return;
  if (wifiLong) startWiFiPortal();
  if (doorlockLong) startPairing();
}

// Pencatat putus WiFi baru dipasang setelah tersambung pertama kali, supaya percobaan awal tidak ikut terhitung.
// OLED ikut diperbarui kalau status WiFi berubah (hanya di luar mode pairing).
void watchWiFi() {
  bool connected = WiFi.status() == WL_CONNECTED;

  if (connected && !dropWatchStarted) {
    dropWatchStarted = true;
    // ESP-NOW memakai channel yang sama dengan router, doorlock menemukannya lewat beacon saat pairing
    Serial.printf("WiFi terhubung, IP %s, channel %d, MAC gateway %s\n",
                  WiFi.localIP().toString().c_str(), WiFi.channel(), gatewayMac.c_str());
    WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info) {
      if (wifiDropAt == 0) {
        wifiDropAt = millis();
        wifiDropReason = info.wifi_sta_disconnected.reason;
      }
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  }

  if (!pairingActive && connected != shownConnected) showWiFiStatus();
}

/* ===== PERINTAH KE DOORLOCK ===== */
void sendDoorlockCommand(Room &r, uint8_t code, const char *label) {
  r.lastCommandAt = millis();

  if (r.simActive) {
    if (r.online && code == CMD_RFID_BLOCK) Serial.printf("[SIM] Doorlock %s: akses kartu RFID DIBLOKIR, kartu akan ditolak.\n", r.key.c_str());
    else if (r.online && code == CMD_RFID_ALLOW) Serial.printf("[SIM] Doorlock %s: akses kartu RFID DIIZINKAN, kartu bisa membuka pintu.\n", r.key.c_str());
    else if (r.online) Serial.printf("[SIM] Doorlock %s menerima perintah %s.\n", r.key.c_str(), label);
    else Serial.printf("[CMD] %s -> %s tidak sampai, doorlock terputus (%s).\n", label, r.key.c_str(), r.connectionReason.c_str());
    return;
  }
  if (!r.hasMac) {
    Serial.printf("[CMD] %s -> %s dilewati (belum ada doorlock).\n", label, r.key.c_str());
    return;
  }
  if (r.tracked && !r.online) {
    Serial.printf("[CMD] Peringatan: doorlock %s sedang terputus (%s), perintah mungkin tidak sampai.\n",
                  r.key.c_str(), r.connectionReason.c_str());
  }
  DoorMessage msg = { DOOR_MSG_HEADER, code };
  esp_err_t err = esp_now_send(r.mac, (uint8_t*)&msg, sizeof(msg));
  Serial.printf("[CMD] %s -> %s (%s)%s\n", label, r.key.c_str(), r.doorlockMac.c_str(), err == ESP_OK ? "" : " GAGAL kirim");
}

void onRoomStatusChanged(Room &r) {
  if (r.status == "unlocked") sendDoorlockCommand(r, CMD_UNLOCK, "UNLOCK");
  else sendDoorlockCommand(r, CMD_LOCK, "LOCK");
}

void onRfidAccessChanged(Room &r) {
  if (r.rfidAccess) sendDoorlockCommand(r, CMD_RFID_ALLOW, "RFID_ALLOW");
  else sendDoorlockCommand(r, CMD_RFID_BLOCK, "RFID_BLOCK");
}

void updateBlockedList() {
  portENTER_CRITICAL(&mux);
  blockedCount = 0;
  for (int i = 0; i < roomCount; i++) {
    if (rooms[i].hasMac && !rooms[i].rfidAccess) memcpy(blockedMac[blockedCount++], rooms[i].mac, 6);
  }
  portEXIT_CRITICAL(&mux);
}

/* ===== KLASIFIKASI GATEWAY ===== */
void stopStream() {
  if (!streaming) return;
  Firebase.RTDB.endStream(&stream);
  streaming = false;
}

void forgetGatewayPath() {
  stopStream();
  gatewayPath = "";
  roomCount = 0;
  pendingRegistered = false;
  prefs.remove("path");
}

// Cari node gateway yang gatewayMac-nya = MAC gateway ini (diisi admin lewat modal "Klasifikasikan Gateway")
bool discoverGatewayPath() {
  if (!Firebase.RTDB.get(&fbdo, "locations")) { printFirebaseError("Cari lokasi gateway"); return false; }
  if (fbdo.dataType() != "json") return false;

  JsonDocument doc;
  if (deserializeJson(doc, fbdo.payload())) return false;

  for (JsonPairConst loc : doc.as<JsonObjectConst>()) {
    if (!loc.value().is<JsonObjectConst>()) continue;
    for (JsonPairConst floor : loc.value().as<JsonObjectConst>()) {
      if (!floor.value().is<JsonObjectConst>()) continue;  // lewati name/address
      for (JsonPairConst gw : floor.value().as<JsonObjectConst>()) {
        if (!gw.value().is<JsonObjectConst>()) continue;   // lewati createdAt
        const char *mac = gw.value()["gatewayMac"] | "";
        if (gatewayMac.equalsIgnoreCase(mac)) {
          gatewayPath = String("locations/") + loc.key().c_str() + "/" + floor.key().c_str() + "/" + gw.key().c_str();
          prefs.putString("path", gatewayPath);
          Serial.printf("[GATEWAY] Terklasifikasi di %s\n", gatewayPath.c_str());
          return true;
        }
      }
    }
  }
  return false;
}

// Daftarkan diri ke pendingGateways supaya muncul di panel admin "Gateway Menunggu Klasifikasi"
void registerPendingGateway() {
  String path = "pendingGateways/" + gatewayMac;
  if (!Firebase.RTDB.get(&fbdo, path)) { printFirebaseError("Cek pendingGateways"); return; }

  if (fbdo.dataType() != "null") {
    pendingRegistered = true;  // sudah terdaftar sebelumnya, pairedAt lama dipertahankan
    return;
  }

  FirebaseJson json;
  json.set("pairedAt/.sv", "timestamp");
  if (Firebase.RTDB.setJSON(&fbdo, path, &json)) {
    pendingRegistered = true;
    Serial.println("[GATEWAY] Terdaftar di pendingGateways, menunggu klasifikasi admin.");
  } else {
    printFirebaseError("Daftar pendingGateways");
  }
}

/* ===== SINKRONISASI KAMAR ===== */
void writeDoorlockState(Room &r);

// Salin state yang hanya ada di RAM (koneksi, baterai, simulasi) dari data kamar lama ke yang baru dibaca
void copyRuntimeState(Room &dst, const Room &src) {
  dst.tracked = src.tracked;
  dst.online = src.online;
  dst.battery = src.battery;
  dst.connectionReason = src.connectionReason;
  dst.lastHeartbeatAt = src.lastHeartbeatAt;
  dst.lastCommandAt = src.lastCommandAt;
  dst.simActive = src.simActive;
  dst.simSignal = src.simSignal;
  dst.simBattery = src.simBattery;
  dst.simRelockAt = src.simRelockAt;
  dst.simLastBeatAt = src.simLastBeatAt;
}

bool isDummyRoom(const String &key) {
  String list = String(DUMMY_ROOMS) + ",";
  for (int start = 0, comma; (comma = list.indexOf(',', start)) >= 0; start = comma + 1) {
    String number = list.substring(start, comma);
    number.trim();
    if (number.length() && key == "Kamar " + number) return true;
  }
  return false;
}

void startSimulation(Room &r, bool dummy) {
  r.simActive = true;
  r.simSignal = true;
  r.simBattery = DUMMY_BATTERY;
  r.simLastBeatAt = 0;
  r.simRelockAt = 0;
  Serial.printf("[SIM] %s doorlock %s dimulai (baterai %d%%), kirim data tiap %d detik. Ubah baterai: battery %s <0-100>\n",
                dummy ? "Dummy" : "Simulasi", r.key.c_str(), r.simBattery, HEARTBEAT_INTERVAL_MS / 1000,
                r.key.substring(6).c_str());
}

// Baca ulang seluruh node gateway (kecil, tanpa history), bandingkan dengan data lama, kirim perintah bila berubah.
// Kamar = semua child berbentuk object (gatewayMac/createdAt otomatis terlewati), sama seperti getRooms() di website.
void refreshRooms() {
  if (!Firebase.RTDB.get(&fbdo, dbPath(gatewayPath))) { printFirebaseError("Baca node gateway"); return; }

  JsonDocument doc;
  if (fbdo.dataType() != "json" || deserializeJson(doc, fbdo.payload())) {
    if (useFixedPath) {
      Serial.printf("[GATEWAY] Node %s tidak ditemukan/kosong.\n", gatewayPath.c_str());
      roomCount = 0;
    } else {
      Serial.println("[GATEWAY] Node gateway dihapus admin, kembali ke mode menunggu klasifikasi.");
      forgetGatewayPath();
    }
    return;
  }

  JsonObjectConst gw = doc.as<JsonObjectConst>();
  if (!useFixedPath && !gatewayMac.equalsIgnoreCase(gw["gatewayMac"] | "")) {
    Serial.println("[GATEWAY] gatewayMac di node ini sudah diganti, kembali ke mode menunggu klasifikasi.");
    forgetGatewayPath();
    return;
  }

  Room fresh[MAX_ROOMS];
  bool resync[MAX_ROOMS];
  int freshCount = 0;
  for (JsonPairConst kv : gw) {
    if (!kv.value().is<JsonObjectConst>() || freshCount >= MAX_ROOMS) continue;
    if (strcmp(kv.key().c_str(), "gatewayStatus") == 0) continue;  // status gateway, bukan kamar
    JsonObjectConst obj = kv.value().as<JsonObjectConst>();

    Room r;
    r.key = kv.key().c_str();
    r.status = obj["status"] | "locked";
    r.rfidAccess = obj["rfidAccess"] | true;
    r.doorlockMac = obj["doorlockMac"] | "";
    r.doorlockMac.toUpperCase();
    r.hasMac = parseMac(r.doorlockMac, r.mac);
    if (r.hasMac) ensurePeer(r.mac);

    Room *old = findRoomByKey(r.key);
    if (old) {
      copyRuntimeState(r, *old);
    } else {
      // Pertama kali terbaca: koneksi baru dipantau setelah doorlock mengirim heartbeat pertama
      r.battery = obj["battery"] | -1;
      r.connectionReason = obj["connectionReason"] | "";
      if (isDummyRoom(r.key)) startSimulation(r, true);
    }

    // Perintah hanya dikirim untuk perubahan, bukan saat kamar pertama kali terbaca
    if (old && old->status != r.status) onRoomStatusChanged(r);
    if (old && old->rfidAccess != r.rfidAccess) onRfidAccessChanged(r);

    // Field status doorlock hilang dari Firebase (mis. kamar diedit dari website, yang menimpa seluruh node kamar)
    resync[freshCount] = r.tracked && !obj["connectionReason"].is<const char*>();
    fresh[freshCount++] = r;
  }

  for (int i = 0; i < freshCount; i++) rooms[i] = fresh[i];
  roomCount = freshCount;
  updateBlockedList();

  for (int i = 0; i < roomCount; i++) {
    if (resync[i]) writeDoorlockState(rooms[i]);
  }
}

void startStream() {
  if (Firebase.RTDB.beginStream(&stream, dbPath(gatewayPath))) {
    streaming = true;
    Serial.printf("[STREAM] Memantau %s\n", gatewayPath.c_str());
  } else if (millis() - lastStreamErrorAt > 5000) {
    lastStreamErrorAt = millis();
    Serial.printf("[STREAM] Gagal mulai: %s\n", stream.errorReason().c_str());
  }
}

// Setiap perubahan di node gateway (dari website maupun gateway sendiri) memicu refreshRooms()
void handleStream() {
  if (!Firebase.RTDB.readStream(&stream)) {
    if (millis() - lastStreamErrorAt > 5000) {
      lastStreamErrorAt = millis();
      Serial.printf("[STREAM] %s\n", stream.errorReason().c_str());
    }
    return;
  }
  if (stream.streamTimeout()) Serial.println("[STREAM] Timeout, menyambung ulang...");
  if (stream.streamAvailable()) roomsDirty = true;
}

/* ===== LAPORAN KE FIREBASE ===== */
// Doorlock lolos pairing HMAC -> muncul di panel admin "Doorlock Menunggu Klasifikasi"
void reportDoorlockPaired(const String &doorlockMac) {
  Room *existing = findRoomByDoorlock(doorlockMac);
  if (existing) {
    Serial.printf("[PAIRING] %s sudah terpasang di %s.\n", doorlockMac.c_str(), existing->key.c_str());
    return;
  }

  FirebaseJson json;
  json.set("gatewayMac", gatewayMac);
  json.set("pairedAt/.sv", "timestamp");
  if (Firebase.RTDB.setJSON(&fbdo, "pendingDevices/" + doorlockMac, &json)) {
    Serial.printf("[PAIRING] %s VALID, terdaftar di pendingDevices.\n", doorlockMac.c_str());
  } else {
    printFirebaseError("Daftar pendingDevices");
  }
}

// Tulis status kamar ke Firebase. Status lokal di-update duluan supaya refreshRooms() tidak menganggapnya perubahan baru.
bool setRoomStatus(Room *r, bool unlocked, const char *source) {
  r->status = unlocked ? "unlocked" : "locked";
  String roomPath = gatewayPath + "/" + r->key;

  FirebaseJson update;
  update.set("status", r->status);
  if (unlocked) update.set("unlockedAt/.sv", "timestamp");
  if (!Firebase.RTDB.updateNode(&fbdo, dbPath(roomPath), &update)) { printFirebaseError("Update status kamar"); return false; }
  if (!unlocked) Firebase.RTDB.deleteNode(&fbdo, dbPath(roomPath + "/unlockedAt"));

  Serial.printf("[GATEWAY] %s %s (%s).\n", r->key.c_str(), r->status.c_str(), source);
  return true;
}

// Doorlock membuka/mengunci sendiri (mis. tap RFID) -> status di dashboard ikut update
void reportDoorEvent(const String &doorlockMac, bool unlocked) {
  Room *r = findRoomByDoorlock(doorlockMac);
  if (!r) {
    Serial.printf("[GATEWAY] Laporan dari %s diabaikan (tidak terpasang di kamar manapun pada gateway ini).\n", doorlockMac.c_str());
    return;
  }
  setRoomStatus(r, unlocked, "dilaporkan doorlock");
}

/* ===== STATUS DOORLOCK: baterai, kunci, koneksi ===== */
void writeDoorlockState(Room &r) {
  FirebaseJson update;
  update.set("connection", r.online ? "connected" : "disconnected");
  update.set("connectionReason", r.connectionReason);
  if (r.battery >= 0) update.set("battery", r.battery);
  update.set("connectionUpdatedAt/.sv", "timestamp");
  if (!Firebase.RTDB.updateNode(&fbdo, dbPath(gatewayPath + "/" + r.key), &update)) printFirebaseError("Update status doorlock");
}

void markDisconnected(Room &r, const String &reason) {
  r.online = false;
  r.connectionReason = reason;
  Serial.printf("[NOTIF] %s: doorlock TERPUTUS dari gateway - %s.\n", r.key.c_str(), reason.c_str());
  writeDoorlockState(r);
}

// Status berkala dari doorlock (sungguhan lewat ESP-NOW, atau simulasi)
void handleHeartbeat(Room &r, int battery, bool unlocked) {
  bool changed = false;
  r.lastHeartbeatAt = millis();
  r.tracked = true;

  if (!r.online) {
    r.online = true;
    r.connectionReason = "Doorlock tersambung ke gateway";
    Serial.printf("[NOTIF] %s: doorlock TERSAMBUNG ke gateway (baterai %d%%).\n", r.key.c_str(), battery);
    changed = true;
  }
  if (battery != r.battery) {
    if (battery <= BATTERY_LOW && (r.battery < 0 || r.battery > BATTERY_LOW)) {
      Serial.printf("[NOTIF] %s: baterai doorlock lemah (%d%%), segera ganti/isi ulang.\n", r.key.c_str(), battery);
    }
    r.battery = battery;
    changed = true;
  }
  if (changed) writeDoorlockState(r);

  // Posisi kunci fisik. Diabaikan sesaat setelah perintah dikirim supaya tidak menimpa perintah yang belum dijalankan.
  if (unlocked != (r.status == "unlocked") && millis() - r.lastCommandAt > COMMAND_GRACE_MS) {
    setRoomStatus(&r, unlocked, "dilaporkan doorlock");
  }
}

// Doorlock simulasi yang berhenti mengirim heartbeat dianggap terputus; penyebabnya ditebak dari data terakhir.
// Doorlock sungguhan tidur di antara aktivitas, jadi tidak dipantau lewat heartbeat.
void checkHeartbeatTimeouts() {
  for (int i = 0; i < roomCount; i++) {
    Room &r = rooms[i];
    if (!r.simActive || !r.tracked || !r.online || millis() - r.lastHeartbeatAt < HEARTBEAT_TIMEOUT_MS) continue;

    if (r.battery >= 0 && r.battery <= BATTERY_EMPTY) {
      markDisconnected(r, "Baterai doorlock habis (terakhir " + String(r.battery) + "%)");
    } else {
      markDisconnected(r, "Sinyal terputus, doorlock di luar jangkauan gateway atau ada gangguan jaringan");
    }
  }
}

/* ===== SIMULASI DOORLOCK (tanpa perangkat fisik) =====
   Meniru doorlock yang mengirim heartbeat tiap HEARTBEAT_INTERVAL_MS lewat jalur yang sama dengan doorlock
   sungguhan (handleHeartbeat), jadi notifikasi & deteksi terputus ikut teruji. */
void runSimulations() {
  for (int i = 0; i < roomCount; i++) {
    Room &r = rooms[i];
    if (!r.simActive) continue;

    // Doorlock mengunci sendiri setelah dibuka kartu RFID
    if (r.simRelockAt && millis() >= r.simRelockAt) {
      r.simRelockAt = 0;
      if (r.status == "unlocked") setRoomStatus(&r, false, "dikunci otomatis oleh doorlock");
    }

    // Sinyal diputus atau doorlock sudah mati -> heartbeat berhenti, checkHeartbeatTimeouts() yang mendeteksi
    if (!r.simSignal || (r.simBattery <= 0 && !r.online)) continue;
    if (r.simLastBeatAt != 0 && millis() - r.simLastBeatAt < HEARTBEAT_INTERVAL_MS) continue;
    r.simLastBeatAt = millis();

    if (r.simBattery == 0) {
      // Doorlock sungguhan juga mengirim EVT_BATTERY_SHUTDOWN sebelum mati
      r.battery = 0;
      markDisconnected(r, "Baterai doorlock habis (0%), doorlock mati");
      continue;
    }
    // Doorlock simulasi selalu menjalankan perintah terakhir, jadi posisi kuncinya = status kamar
    handleHeartbeat(r, r.simBattery, r.status == "unlocked");
  }
}

/* ===== STATUS GATEWAY ===== */
const char *restartReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "Gateway dinyalakan (listrik sempat mati atau kabel dicabut)";
    case ESP_RST_BROWNOUT: return "Tegangan listrik gateway turun (brownout)";
    case ESP_RST_PANIC:
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      return "Gateway restart karena error program";
    case ESP_RST_SW:       return "Gateway di-restart oleh program";
    case ESP_RST_EXT:      return "Gateway di-reset lewat tombol reset";
    default:               return "Gateway dinyalakan ulang (reset lewat USB / upload program)";
  }
}

String wifiDropText(uint8_t reason) {
  switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:        return "WiFi tidak ditemukan (router/hotspot mati atau di luar jangkauan)";
    case WIFI_REASON_BEACON_TIMEOUT:     return "Sinyal WiFi hilang (router/hotspot mati atau terlalu jauh)";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "Password WiFi ditolak router";
    default:                             return "Koneksi WiFi terputus (kode " + String(reason) + ")";
  }
}

// Tanda "gateway masih hidup" untuk website + alasan restart / putus WiFi terakhir
void reportGatewayStatus() {
  FirebaseJson update;
  update.set("lastSeen/.sv", "timestamp");
  if (!restartReported) {
    update.set("lastRestartReason", restartReasonText());
    update.set("lastRestartAt/.sv", "timestamp");
  }
  unsigned long dropAt = wifiDropAt;
  if (dropAt) {
    update.set("lastDisconnectReason", wifiDropText(wifiDropReason));
    update.set("lastDisconnectSeconds", (int)((millis() - dropAt) / 1000));
    update.set("lastReconnectAt/.sv", "timestamp");
  }

  if (!Firebase.RTDB.updateNode(&fbdo, dbPath(gatewayPath + "/gatewayStatus"), &update)) {
    printFirebaseError("Lapor status gateway");
    return;
  }
  if (!restartReported) Serial.printf("[GATEWAY] Status online dilaporkan (%s).\n", restartReasonText());
  if (dropAt) {
    Serial.printf("[NOTIF] Gateway tersambung lagi setelah %lu detik terputus: %s.\n",
                  (millis() - dropAt) / 1000, wifiDropText(wifiDropReason).c_str());
    wifiDropAt = 0;
  }
  restartReported = true;
}

/* ===== SIMULASI RFID ===== */
// Blokir/izinkan kartu RFID kamar: simpan ke Firebase (sama seperti tombol di website) lalu kirim ke doorlock
bool setRfidAccess(Room *r, bool allowed) {
  r->rfidAccess = allowed;  // update lokal duluan supaya refreshRooms() tidak mengirim perintah dua kali
  updateBlockedList();
  FirebaseJson update;
  update.set("rfidAccess", allowed);
  if (!Firebase.RTDB.updateNode(&fbdo, dbPath(gatewayPath + "/" + r->key), &update)) { printFirebaseError("Update rfidAccess"); return false; }
  Serial.printf("[GATEWAY] Kartu RFID %s %s (diubah lewat Serial Monitor).\n", r->key.c_str(), allowed ? "DIIZINKAN" : "DIBLOKIR");
  onRfidAccessChanged(*r);
  return true;
}

// Kartu RFID ditempel: diizinkan -> pintu terbuka lalu terkunci sendiri, diblokir -> ditolak
void simulateCardTap(Room &r) {
  if (r.simBattery <= 0) { Serial.printf("[SIM] Kartu ditempel di %s, tapi doorlock mati (baterai habis).\n", r.key.c_str()); return; }
  if (!r.rfidAccess) {
    Serial.printf("[NOTIF] %s: kartu RFID DITOLAK, akses kartu sedang diblokir.\n", r.key.c_str());
    return;
  }
  if (!r.online) {
    Serial.printf("[SIM] Kartu diterima, pintu %s terbuka, tapi doorlock terputus dari gateway sehingga tidak bisa dilaporkan.\n", r.key.c_str());
    return;
  }
  Serial.printf("[NOTIF] %s: kartu RFID DITERIMA, pintu terbuka (terkunci otomatis dalam %d detik).\n", r.key.c_str(), SIM_AUTO_LOCK_MS / 1000);
  if (setRoomStatus(&r, true, "dibuka dengan kartu RFID")) r.simRelockAt = millis() + SIM_AUTO_LOCK_MS;
}

void processEvents() {
  PendingEvent ev;
  while (popEvent(ev)) {
    String mac = macToString(ev.mac);
    Room *r = findRoomByDoorlock(mac);
    switch (ev.code) {
      case EVT_HEARTBEAT:
        if (r) handleHeartbeat(*r, ev.battery, ev.unlocked);
        break;
      case EVT_BATTERY_SHUTDOWN:
        if (r) {
          r->battery = 0;
          markDisconnected(*r, "Baterai doorlock habis, doorlock mati");
        }
        break;
      case EVT_DISCONNECT:
        if (r) markDisconnected(*r, "Doorlock di-reset untuk pairing ulang");
        else Serial.printf("[PAIRING] %s memutus pairing.\n", mac.c_str());
        esp_now_del_peer(ev.mac);
        break;
      case EVT_PAIRED:   reportDoorlockPaired(mac); break;
      case EVT_REJECTED:
        Serial.printf("[PAIRING] %s TIDAK VALID, ditolak.\n", mac.c_str());
        if (!findRoomByDoorlock(mac)) esp_now_del_peer(ev.mac);
        break;
      case EVT_UNLOCKED: reportDoorEvent(mac, true); break;
      case EVT_LOCKED:   reportDoorEvent(mac, false); break;
      default: break;
    }
  }
}

/* ===== PERINTAH SERIAL ===== */
void printHelp() {
  Serial.println("===== PERINTAH GATEWAY (ketik lalu Enter) =====");
  Serial.println("Button:");
  Serial.println("  tahan button 1 (5 detik) pairing WiFi lewat hotspot ISK-Gateway (buka 192.168.4.1 dari HP)");
  Serial.println("  tahan button 2 (5 detik) pairing doorlock, tiap doorlock dikonfirmasi di OLED:");
  Serial.println("                           tekan button 1 = connect, tekan button 2 = lewati");
  Serial.println("Umum:");
  Serial.println("  help                     tampilkan daftar perintah ini");
  Serial.println("  rooms                    daftar kamar: status, RFID, baterai, koneksi doorlock");
  Serial.println("  Pairing                  aktifkan mode pairing doorlock (sama dengan tahan button 2)");
  Serial.println("  reset                    cari ulang lokasi gateway (hanya jika GATEWAY_PATH kosong)");
  Serial.println("Kunci & RFID (tersimpan di Firebase, tampil di website):");
  Serial.println("  unlock 101 / lock 101    buka / kunci Kamar 101");
  Serial.println("  rfid 101 block           blokir kartu RFID Kamar 101");
  Serial.println("  rfid 101 allow           izinkan kartu RFID Kamar 101");
  Serial.println("Simulasi doorlock:");
  Serial.println("  sim 101                  mulai simulasi doorlock Kamar 101 (dummy DUMMY_ROOMS aktif otomatis)");
  Serial.println("  sim 101 stop             hentikan simulasi doorlock Kamar 101");
  Serial.println("  battery 101 75           input manual baterai (0 = habis & doorlock mati, isi lagi = menyala)");
  Serial.println("  signal 101 off / on      putus / sambung sinyal doorlock (terputus terdeteksi setelah 15 detik)");
  Serial.println("  tap 101                  tempel kartu RFID (diizinkan = pintu terbuka, diblokir = ditolak)");
  Serial.println("Simulasi doorlock sungguhan lewat MAC:");
  Serial.println("  pair AA:BB:CC:DD:EE:FF   doorlock lolos pairing -> muncul di panel admin website");
  Serial.println("  unlock AA:BB:CC:DD:EE:FF / lock AA:BB:CC:DD:EE:FF   laporan buka/kunci dari doorlock");
}

// Pairing                    -> aktifkan mode pairing ESP-NOW
// rooms                      -> tampilkan daftar kamar yang tersinkron
// unlock 101 / lock 101      -> ubah status Kamar 101 di Firebase + kirim perintah ke doorlock-nya
// unlock AA:BB:CC:DD:EE:FF   -> simulasi laporan doorlock terbuka (tanpa doorlock fisik)
// lock AA:BB:CC:DD:EE:FF     -> simulasi laporan doorlock terkunci
// pair AA:BB:CC:DD:EE:FF     -> simulasi pairing doorlock berhasil
// sim 101                    -> mulai simulasi doorlock Kamar 101 (tersambung, baterai 100%)
// sim 101 stop               -> hentikan simulasi doorlock Kamar 101
// battery 101 75             -> input manual baterai doorlock simulasi (0 = habis & mati, isi lagi = menyala)
// rfid 101 block / allow     -> blokir/izinkan kartu RFID Kamar 101 (tersimpan di Firebase, dikirim ke doorlock)
// tap 101                    -> simulasi kartu RFID ditempel di doorlock Kamar 101
// signal 101 off / on        -> putus/sambung sinyal doorlock simulasi (di luar jangkauan / gangguan WiFi)
// reset                      -> lupakan lokasi gateway & cari ulang (hanya jika GATEWAY_PATH kosong)
void handleSerialCommand() {
  if (!Serial.available()) return;

  String line = Serial.readStringUntil('\n');
  line.trim();
  int space = line.indexOf(' ');
  String command = space < 0 ? line : line.substring(0, space);
  String arg = space < 0 ? "" : line.substring(space + 1);
  command.toLowerCase();
  arg.trim();
  arg.toUpperCase();

  uint8_t mac[6];
  if (command == "help") {
    printHelp();
  } else if (command == "pairing") {
    startPairing();
  } else if (command == "rooms") {
    Serial.printf("Gateway %s @ %s\n", gatewayMac.c_str(), gatewayPath.length() ? gatewayPath.c_str() : "(belum diklasifikasikan)");
    for (int i = 0; i < roomCount; i++) {
      Room &r = rooms[i];
      String battery = r.battery >= 0 ? String(r.battery) + "%" : String("-");
      Serial.printf("  %s | %s | RFID %s | doorlock %s%s | baterai %s | %s\n", r.key.c_str(), r.status.c_str(),
                    r.rfidAccess ? "izin" : "blokir", r.hasMac ? r.doorlockMac.c_str() : "-", r.simActive ? " (simulasi)" : "",
                    battery.c_str(), !r.tracked ? "koneksi belum dipantau" : r.online ? "TERSAMBUNG" : ("TERPUTUS: " + r.connectionReason).c_str());
    }
  } else if (command == "reset") {
    if (useFixedPath) { Serial.println("GATEWAY_PATH diisi manual, ubah langsung di kode."); return; }
    forgetGatewayPath();
    lastDiscoveryAt = 0;
    Serial.println("Lokasi gateway direset.");
  } else if ((command == "unlock" || command == "lock") && arg.length() && arg.indexOf(':') < 0) {
    Room *r = findRoomByKey("Kamar " + arg);
    if (!r) { Serial.printf("Kamar %s tidak ada di gateway ini (cek dengan \"rooms\").\n", arg.c_str()); return; }
    if (setRoomStatus(r, command == "unlock", "diubah lewat Serial Monitor")) onRoomStatusChanged(*r);
  } else if (command == "pair" || command == "unlock" || command == "lock") {
    if (!parseMac(arg, mac)) { Serial.println("Format MAC: AA:BB:CC:DD:EE:FF"); return; }
    pushEvent(mac, command == "pair" ? EVT_PAIRED : command == "unlock" ? EVT_UNLOCKED : EVT_LOCKED);
  } else if (command == "sim" || command == "battery" || command == "signal" || command == "rfid" || command == "tap") {
    int argSpace = arg.indexOf(' ');
    String roomNumber = argSpace < 0 ? arg : arg.substring(0, argSpace);
    String value = argSpace < 0 ? "" : arg.substring(argSpace + 1);
    value.trim();

    Room *r = findRoomByKey("Kamar " + roomNumber);
    if (!r) { Serial.printf("Kamar %s tidak ada di gateway ini (cek dengan \"rooms\").\n", roomNumber.c_str()); return; }

    if (command == "sim") {
      if (value == "STOP") {
        if (!r->simActive) { Serial.printf("%s tidak sedang disimulasikan.\n", r->key.c_str()); return; }
        r->simActive = false;
        markDisconnected(*r, "Simulasi doorlock dihentikan");
        r->tracked = false;
      } else {
        startSimulation(*r, false);
      }
      return;
    }

    if (command == "rfid") {
      if (value != "BLOCK" && value != "ALLOW") { Serial.println("Format: rfid <nomor kamar> block|allow"); return; }
      setRfidAccess(r, value == "ALLOW");
      return;
    }

    if (!r->simActive) { Serial.printf("Mulai simulasi dulu: sim %s\n", roomNumber.c_str()); return; }
    if (command == "tap") {
      simulateCardTap(*r);
    } else if (command == "battery") {
      if (value.isEmpty()) { Serial.println("Format: battery <nomor kamar> <0-100>"); return; }
      r->simBattery = constrain(value.toInt(), 0, 100);
      r->simLastBeatAt = 0;  // langsung kirim heartbeat berikutnya
      Serial.printf("[SIM] Baterai doorlock %s diubah ke %d%%.\n", r->key.c_str(), r->simBattery);
    } else if (value == "OFF" || value == "ON") {
      r->simSignal = value == "ON";
      r->simLastBeatAt = 0;
      Serial.printf("[SIM] Sinyal doorlock %s %s.\n", r->key.c_str(),
                    r->simSignal ? "disambung lagi" : "diputus, gateway mendeteksi terputus setelah batas waktu heartbeat");
    } else {
      Serial.println("Format: signal <nomor kamar> on|off");
    }
  } else if (command.length()) {
    Serial.printf("Perintah \"%s\" tidak dikenal. Ketik help untuk daftar perintah.\n", line.c_str());
  }
}

/* ===== SETUP & LOOP ===== */
void setup() {
  Serial.begin(115200);
  delay(1000);
  pinMode(BUTTON_WIFI_PIN, INPUT_PULLUP);
  pinMode(BUTTON_DOORLOCK_PIN, INPUT_PULLUP);

  Wire.begin(4, 5);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  show("Gateway", "Siap");

  // Pakai SSID & password yang tersimpan dari pairing WiFi. Kalau belum ada / gagal, gateway tetap jalan
  // (ESP-NOW & button aktif) dan WiFi bisa diatur kapan saja lewat button 1.
  WiFi.mode(WIFI_STA);
  WiFi.begin();
  if (WiFi.waitForConnectResult(WIFI_CONNECT_MS) != WL_CONNECTED) {
    Serial.println("WiFi belum tersambung. Tahan button 1 selama 5 detik untuk mengatur WiFi dari HP.");
  }
  gatewayMac = WiFi.macAddress();

  esp_now_init();
  esp_now_register_recv_cb(onReceive);
  ensurePeer(broadcastAddress);

  wifi_promiscuous_filter_t filter = { WIFI_PROMIS_FILTER_MASK_MGMT };
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(onSniff);
  esp_wifi_set_promiscuous(true);

  prefs.begin("gateway", false);
  gatewayPath = useFixedPath ? String(GATEWAY_PATH) : prefs.getString("path", "");

  // Database secret (legacy token) = akses penuh ke database tanpa akun email, melewati Rules
  fbConfig.database_url = DATABASE_URL;
  fbConfig.signer.tokens.legacy_token = DATABASE_SECRET;

  Firebase.reconnectNetwork(true);
  Firebase.begin(&fbConfig, &fbAuth);

  showWiFiStatus();
  Serial.println("Ketik \"help\" untuk daftar perintah.");
}

void loop() {
  handleSerialCommand();
  handleButtons();
  processPairing();  // ESP-NOW & button tetap jalan walau WiFi/Firebase belum tersambung
  showPairingResult();
  watchWiFi();

  if (!Firebase.ready()) return;
  processEvents();

  if (gatewayPath.isEmpty()) {
    if (lastDiscoveryAt == 0 || millis() - lastDiscoveryAt >= DISCOVERY_RETRY_MS) {
      lastDiscoveryAt = millis();
      if (!discoverGatewayPath() && !pendingRegistered) registerPendingGateway();
    }
    return;
  }

  if (!streaming) {
    startStream();
    return;
  }

  handleStream();
  if (roomsDirty) {
    roomsDirty = false;
    refreshRooms();
  }

  if (lastGatewayBeatAt == 0 || millis() - lastGatewayBeatAt >= GATEWAY_HEARTBEAT_MS || wifiDropAt) {
    lastGatewayBeatAt = millis();
    reportGatewayStatus();
  }

  runSimulations();
  checkHeartbeatTimeouts();
}

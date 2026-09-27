#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>

/* ===== KONFIGURASI ===== */
#define WIFI_SSID        "ISI_SSID_WIFI"
#define WIFI_PASSWORD    "ISI_PASSWORD_WIFI"

#define API_KEY          "AIzaSyDQbNT5P1naNasch6GHjBXPrP5assqJ3Yo"
#define DATABASE_URL     "https://isk-house-default-rtdb.asia-southeast1.firebasedatabase.app"

// Akun Firebase Auth khusus gateway. Rules: locations boleh ditulis admin/approved,
// pendingGateways & pendingDevices hanya admin -> akun ini perlu users/{uid}/role = "admin".
#define GATEWAY_EMAIL    "ISI_EMAIL_AKUN_GATEWAY"
#define GATEWAY_PASSWORD "ISI_PASSWORD_AKUN_GATEWAY"

// Path node gateway di database. Isi untuk gateway yang dibuat manual dari dashboard (tanpa gatewayMac);
// kosongkan ("") supaya gateway mencari sendiri lewat gatewayMac hasil klasifikasi admin.
#define GATEWAY_PATH     "locations/ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja/Lantai 1/Gateway 1"

#define MAX_ROOMS           20      // sama dengan MAX_ROOMS di Website/main.js
#define DISCOVERY_RETRY_MS  15000   // jeda cek ulang apakah gateway sudah diklasifikasikan admin
#define PAIRING_WINDOW_MS   60000   // lama mode pairing aktif setelah perintah "Pairing"
#define CHALLENGE_TIMEOUT   2000
#define MAX_QUEUE           16
#define MAX_EVENTS          8

/* Struktur database (history tidak disimpan di Firebase, hanya di localStorage website):
   locations/{cabang}/{lantai}/{gateway}/gatewayMac (opsional)
   locations/{cabang}/{lantai}/{gateway}/Kamar {n}: { tenant, rfidAccess, status, unlockedAt, doorlockMac }
   pendingGateways/{macGateway}: { pairedAt }
   pendingDevices/{macDoorlock}: { gatewayMac, pairedAt } */

/* ===== ESP-NOW: pairing HMAC (lihat Document/Documentation/HMAC.md) ===== */
const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 }; // Kos ISK, Doorlock, HW v0, SW v0
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

/* Pesan setelah pairing (2 byte). Belum terenkripsi — PMK/LMK belum diterapkan, lihat HMAC.md bagian 6. */
#define DOOR_MSG_HEADER 0xD0
enum : uint8_t {
  CMD_LOCK       = 0x01,  // gateway -> doorlock
  CMD_UNLOCK     = 0x02,
  CMD_RFID_ALLOW = 0x03,
  CMD_RFID_BLOCK = 0x04,
  EVT_LOCKED     = 0x11,  // doorlock -> gateway
  EVT_UNLOCKED   = 0x12,
  EVT_PAIRED     = 0xF0,  // internal: hasil pairing HMAC, dari callback ke loop()
  EVT_REJECTED   = 0xF1
};

typedef struct {
  uint8_t header;
  uint8_t code;
} DoorMessage;

typedef struct {
  String key;          // "Kamar 101"
  String doorlockMac;  // kosong kalau kamar belum terhubung ke doorlock
  uint8_t mac[6];
  bool hasMac;
  String status;       // "locked" / "unlocked"
  bool rfidAccess;
} Room;

typedef struct {
  uint8_t mac[6];
  uint8_t code;
} PendingEvent;

/* ===== STATE ===== */
FirebaseData fbdo;    // request biasa (get/set/update)
FirebaseData stream;  // koneksi stream ke node gateway
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
Preferences prefs;

const bool useFixedPath = sizeof(GATEWAY_PATH) > 1;

String gatewayMac;
String gatewayPath;  // "locations/{cabang}/{lantai}/{gateway}", kosong = belum diklasifikasikan admin
bool pendingRegistered = false;
bool streaming = false;
bool roomsDirty = false;
unsigned long lastDiscoveryAt = 0;
unsigned long lastStreamErrorAt = 0;

Room rooms[MAX_ROOMS];
int roomCount = 0;

// Pairing — sebagian state disentuh callback ESP-NOW (task WiFi), jadi dilindungi mux
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
volatile bool pairingActive = false;
unsigned long pairingStartedAt = 0;
uint8_t queueMac[MAX_QUEUE][6];
volatile int queueCount = 0;
uint8_t currentMac[6];
volatile uint32_t currentNonce = 0;
unsigned long challengeSentAt = 0;
volatile bool awaitingResponse = false;

// Antrian kejadian dari callback ESP-NOW ke loop() (Firebase tidak boleh dipanggil dari callback)
PendingEvent events[MAX_EVENTS];
volatile int eventHead = 0;
volatile int eventTail = 0;

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
void pushEvent(const uint8_t *mac, uint8_t code) {
  portENTER_CRITICAL(&mux);
  int next = (eventHead + 1) % MAX_EVENTS;
  if (next != eventTail) {
    memcpy(events[eventHead].mac, mac, 6);
    events[eventHead].code = code;
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
void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  // Laporan doorlock (buka/kunci). Dicek di loop() apakah MAC-nya memang terpasang di salah satu kamar.
  if (len == sizeof(DoorMessage) && data[0] == DOOR_MSG_HEADER) {
    pushEvent(mac, data[1]);
    return;
  }

  if (!pairingActive) return;

  if (len == sizeof(TAG) && memcmp(data, TAG, sizeof(TAG)) == 0) {
    portENTER_CRITICAL(&mux);
    bool skip = (awaitingResponse && memcmp(mac, currentMac, 6) == 0) || queueCount >= MAX_QUEUE;
    for (int i = 0; i < queueCount && !skip; i++) {
      if (memcmp(queueMac[i], mac, 6) == 0) skip = true;
    }
    if (!skip) {
      memcpy(queueMac[queueCount], mac, 6);
      queueCount++;
    }
    portEXIT_CRITICAL(&mux);
    return;
  }

  if (len == sizeof(AuthMessage) && awaitingResponse) {
    if (memcmp(mac, currentMac, 6) != 0) return;

    const AuthMessage *reply = (const AuthMessage*)data;
    if (reply->nonce != currentNonce) return;

    uint8_t expectedProof[3];
    computeProof(currentNonce, expectedProof);
    pushEvent(mac, memcmp(reply->proof, expectedProof, 3) == 0 ? EVT_PAIRED : EVT_REJECTED);
    awaitingResponse = false;
  }
}

/* ===== ESP-NOW: PROSES PAIRING (satu kandidat per giliran, lihat HMAC.md bagian 3.2) ===== */
void startPairing() {
  pairingActive = true;
  pairingStartedAt = millis();
  Serial.printf("[PAIRING] Mode pairing aktif %d detik (channel WiFi %d).\n", PAIRING_WINDOW_MS / 1000, WiFi.channel());
}

void processPairing() {
  if (!pairingActive) return;

  if (awaitingResponse && millis() - challengeSentAt > CHALLENGE_TIMEOUT) {
    Serial.printf("[PAIRING] Timeout menunggu balasan dari %s.\n", macToString(currentMac).c_str());
    if (!findRoomByDoorlock(macToString(currentMac))) esp_now_del_peer(currentMac);
    awaitingResponse = false;
  }

  if (awaitingResponse) return;

  if (queueCount == 0) {
    if (millis() - pairingStartedAt > PAIRING_WINDOW_MS) {
      pairingActive = false;
      Serial.println("[PAIRING] Mode pairing selesai.");
    }
    return;
  }

  portENTER_CRITICAL(&mux);
  memcpy(currentMac, queueMac[0], 6);
  for (int i = 1; i < queueCount; i++) memcpy(queueMac[i - 1], queueMac[i], 6);
  queueCount--;
  portEXIT_CRITICAL(&mux);

  ensurePeer(currentMac);
  currentNonce = esp_random();
  AuthMessage challenge = { currentNonce, {0, 0, 0} };
  challengeSentAt = millis();
  awaitingResponse = true;
  esp_now_send(currentMac, (uint8_t*)&challenge, sizeof(challenge));

  Serial.printf("[PAIRING] Challenge dikirim ke %s (nonce=0x%08X).\n", macToString(currentMac).c_str(), currentNonce);
}

/* ===== PERINTAH KE DOORLOCK ===== */
void sendDoorlockCommand(const Room &r, uint8_t code, const char *label) {
  if (!r.hasMac) {
    Serial.printf("[CMD] %s -> %s dilewati (belum ada doorlock).\n", label, r.key.c_str());
    return;
  }
  DoorMessage msg = { DOOR_MSG_HEADER, code };
  esp_err_t err = esp_now_send(r.mac, (uint8_t*)&msg, sizeof(msg));
  Serial.printf("[CMD] %s -> %s (%s)%s\n", label, r.key.c_str(), r.doorlockMac.c_str(), err == ESP_OK ? "" : " GAGAL kirim");
}

void onRoomStatusChanged(const Room &r) {
  if (r.status == "unlocked") sendDoorlockCommand(r, CMD_UNLOCK, "UNLOCK");
  else sendDoorlockCommand(r, CMD_LOCK, "LOCK");
}

void onRfidAccessChanged(const Room &r) {
  if (r.rfidAccess) sendDoorlockCommand(r, CMD_RFID_ALLOW, "RFID_ALLOW");
  else sendDoorlockCommand(r, CMD_RFID_BLOCK, "RFID_BLOCK");
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
// Baca ulang seluruh node gateway (kecil, tanpa history), bandingkan dengan data lama, kirim perintah bila berubah.
// Kamar = semua child berbentuk object (gatewayMac/createdAt otomatis terlewati), sama seperti getRooms() di website.
void refreshRooms() {
  if (!Firebase.RTDB.get(&fbdo, gatewayPath)) { printFirebaseError("Baca node gateway"); return; }

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
  int freshCount = 0;
  for (JsonPairConst kv : gw) {
    if (!kv.value().is<JsonObjectConst>() || freshCount >= MAX_ROOMS) continue;
    JsonObjectConst obj = kv.value().as<JsonObjectConst>();

    Room r;
    r.key = kv.key().c_str();
    r.status = obj["status"] | "locked";
    r.rfidAccess = obj["rfidAccess"] | true;
    r.doorlockMac = obj["doorlockMac"] | "";
    r.doorlockMac.toUpperCase();
    r.hasMac = parseMac(r.doorlockMac, r.mac);
    if (r.hasMac) ensurePeer(r.mac);

    // Perintah hanya dikirim untuk perubahan, bukan saat kamar pertama kali terbaca
    Room *old = findRoomByKey(r.key);
    if (old && old->status != r.status) onRoomStatusChanged(r);
    if (old && old->rfidAccess != r.rfidAccess) onRfidAccessChanged(r);

    fresh[freshCount++] = r;
  }

  for (int i = 0; i < freshCount; i++) rooms[i] = fresh[i];
  roomCount = freshCount;
}

void startStream() {
  if (Firebase.RTDB.beginStream(&stream, gatewayPath)) {
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

// Doorlock membuka/mengunci sendiri (mis. tap RFID) -> status di dashboard ikut update
void reportDoorEvent(const String &doorlockMac, bool unlocked) {
  Room *r = findRoomByDoorlock(doorlockMac);
  if (!r) {
    Serial.printf("[GATEWAY] Laporan dari %s diabaikan (tidak terpasang di kamar manapun pada gateway ini).\n", doorlockMac.c_str());
    return;
  }

  // Update status lokal duluan supaya refreshRooms() tidak mengirim balik perintah yang sama ke doorlock
  r->status = unlocked ? "unlocked" : "locked";
  String roomPath = gatewayPath + "/" + r->key;

  FirebaseJson update;
  update.set("status", r->status);
  if (unlocked) update.set("unlockedAt/.sv", "timestamp");
  if (!Firebase.RTDB.updateNode(&fbdo, roomPath, &update)) { printFirebaseError("Update status kamar"); return; }
  if (!unlocked) Firebase.RTDB.deleteNode(&fbdo, roomPath + "/unlockedAt");

  Serial.printf("[GATEWAY] %s %s (dilaporkan doorlock).\n", r->key.c_str(), r->status.c_str());
}

void processEvents() {
  PendingEvent ev;
  while (popEvent(ev)) {
    String mac = macToString(ev.mac);
    switch (ev.code) {
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
// Pairing                    -> aktifkan mode pairing ESP-NOW
// rooms                      -> tampilkan daftar kamar yang tersinkron
// unlock AA:BB:CC:DD:EE:FF   -> simulasi laporan doorlock terbuka (tanpa doorlock fisik)
// lock AA:BB:CC:DD:EE:FF     -> simulasi laporan doorlock terkunci
// pair AA:BB:CC:DD:EE:FF     -> simulasi pairing doorlock berhasil
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
  if (command == "pairing") {
    startPairing();
  } else if (command == "rooms") {
    Serial.printf("Gateway %s @ %s\n", gatewayMac.c_str(), gatewayPath.length() ? gatewayPath.c_str() : "(belum diklasifikasikan)");
    for (int i = 0; i < roomCount; i++) {
      Serial.printf("  %s | %s | RFID %s | doorlock %s\n", rooms[i].key.c_str(), rooms[i].status.c_str(),
                    rooms[i].rfidAccess ? "izin" : "blokir", rooms[i].hasMac ? rooms[i].doorlockMac.c_str() : "-");
    }
  } else if (command == "reset") {
    if (useFixedPath) { Serial.println("GATEWAY_PATH diisi manual, ubah langsung di kode."); return; }
    forgetGatewayPath();
    lastDiscoveryAt = 0;
    Serial.println("Lokasi gateway direset.");
  } else if (command == "pair" || command == "unlock" || command == "lock") {
    if (!parseMac(arg, mac)) { Serial.println("Format MAC: AA:BB:CC:DD:EE:FF"); return; }
    pushEvent(mac, command == "pair" ? EVT_PAIRED : command == "unlock" ? EVT_UNLOCKED : EVT_LOCKED);
  } else if (command.length()) {
    Serial.println("Perintah: Pairing, rooms, reset, pair|unlock|lock <MAC>");
  }
}

/* ===== SETUP & LOOP ===== */
void setup() {
  Serial.begin(115200);
  delay(1000);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Menghubungkan WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(500);
  }
  gatewayMac = WiFi.macAddress();
  // ESP-NOW memakai channel yang sama dengan router -> doorlock harus berada di channel ini juga
  Serial.printf("\nWiFi terhubung, IP %s, channel %d, MAC gateway %s\n",
                WiFi.localIP().toString().c_str(), WiFi.channel(), gatewayMac.c_str());

  esp_now_init();
  esp_now_register_recv_cb(onReceive);

  prefs.begin("gateway", false);
  gatewayPath = useFixedPath ? String(GATEWAY_PATH) : prefs.getString("path", "");

  fbConfig.api_key = API_KEY;
  fbConfig.database_url = DATABASE_URL;
  fbConfig.token_status_callback = tokenStatusCallback;
  fbAuth.user.email = GATEWAY_EMAIL;
  fbAuth.user.password = GATEWAY_PASSWORD;

  Firebase.reconnectNetwork(true);
  Firebase.begin(&fbConfig, &fbAuth);

  Serial.println("Menunggu login Firebase...");
  while (!Firebase.ready()) delay(100);
  Serial.println("Firebase siap. Ketik \"Pairing\" untuk mulai pairing doorlock.");
}

void loop() {
  handleSerialCommand();
  processPairing();  // ESP-NOW tetap jalan walau Firebase sedang tersambung ulang

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
}

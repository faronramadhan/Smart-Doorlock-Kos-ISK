#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>

/* ===== KONFIGURASI ===== */
#define WIFI_SSID        "ISI_SSID_WIFI"
#define WIFI_PASSWORD    "ISI_PASSWORD_WIFI"

#define API_KEY          "AIzaSyDQbNT5P1naNasch6GHjBXPrP5assqJ3Yo"
#define DATABASE_URL     "https://isk-house-default-rtdb.asia-southeast1.firebasedatabase.app"

// Akun Firebase Auth khusus gateway. Rules saat ini: pendingGateways & pendingDevices hanya boleh ditulis admin,
// jadi akun ini perlu users/{uid}/role = "admin" (lihat database.rules.json).
#define GATEWAY_EMAIL    "ISI_EMAIL_AKUN_GATEWAY"
#define GATEWAY_PASSWORD "ISI_PASSWORD_AKUN_GATEWAY"

// Path node gateway di database. Isi untuk gateway yang dibuat manual dari dashboard (tanpa gatewayMac);
// kosongkan ("") supaya gateway mencari sendiri lewat gatewayMac hasil klasifikasi admin.
#define GATEWAY_PATH     "locations/ISK House Kemayoran - Gg H Abdullah No34, RT9RW9, Utan Panja/Lantai 1/Gateway 1"

#define MAX_ROOMS           20     // sama dengan MAX_ROOMS di Website/main.js
#define MAX_KEYS            32
#define DISCOVERY_RETRY_MS  15000   // jeda cek ulang apakah gateway sudah diklasifikasikan admin
#define ROOM_REFRESH_MS     60000   // jeda baca ulang daftar kamar (kamar baru/dihapus, doorlockMac)
#define STATUS_POLL_MS      200     // jeda antar-request polling status (1 kamar per request, bergiliran)
#define RFID_POLL_EVERY     5       // rfidAccess ikut dicek tiap 5 putaran polling status

/* Struktur database (lihat Catatan Update Website - 17 September 2026):
   locations/{cabang}/{lantai}/{gateway}/gatewayMac
   locations/{cabang}/{lantai}/{gateway}/Kamar {n}: { tenant, rfidAccess, status, unlockedAt, doorlockMac }
   pendingGateways/{macGateway}: { pairedAt }
   pendingDevices/{macDoorlock}: { gatewayMac, pairedAt }

   Riwayat (history) tidak ada di Firebase — hanya disimpan di localStorage website.
   Status kamar dipolling per field, bergiliran 1 kamar per request. */

typedef struct {
  String key;          // "Kamar 201"
  String doorlockMac;  // kosong kalau kamar belum terhubung ke doorlock
  String status;       // "locked" / "unlocked"
  bool rfidAccess;
} Room;

FirebaseData fbdo;
FirebaseAuth fbAuth;
FirebaseConfig fbConfig;
Preferences prefs;

const bool useFixedPath = sizeof(GATEWAY_PATH) > 1;

String gatewayMac;
String gatewayPath;  // "locations/{cabang}/{lantai}/{gateway}", kosong = belum diklasifikasikan admin
bool pendingRegistered = false;

Room rooms[MAX_ROOMS];
int roomCount = 0;
int pollIndex = 0;
int pollRound = 0;

unsigned long lastDiscoveryAt = 0;
unsigned long lastRoomRefreshAt = 0;
unsigned long lastPollAt = 0;

/* ===== HELPER FIREBASE ===== */
enum ReadResult { READ_OK, READ_MISSING, READ_ERROR };

void printFirebaseError(const char *context) {
  Serial.printf("[FIREBASE] %s gagal: %s\n", context, fbdo.errorReason().c_str());
}

ReadResult readString(const String &path, String &out) {
  if (!Firebase.RTDB.get(&fbdo, path)) return READ_ERROR;
  if (fbdo.dataType() != "string") return READ_MISSING;
  out = fbdo.stringData();
  return READ_OK;
}

ReadResult readBool(const String &path, bool &out) {
  if (!Firebase.RTDB.get(&fbdo, path)) return READ_ERROR;
  if (fbdo.dataType() != "boolean") return READ_MISSING;
  out = fbdo.boolData();
  return READ_OK;
}

// Ambil nama-nama child langsung (shallow), tanpa men-download isinya. Return -1 kalau request gagal.
int readShallowKeys(const String &path, String *keys, int maxKeys) {
  if (!Firebase.RTDB.getShallowData(&fbdo, path)) return -1;
  if (fbdo.dataType() != "json") return 0;

  FirebaseJson &json = fbdo.jsonObject();
  size_t len = json.iteratorBegin();
  int n = 0;
  int type;
  String key, value;
  for (size_t i = 0; i < len && n < maxKeys; i++) {
    json.iteratorGet(i, type, key, value);
    keys[n++] = key;
  }
  json.iteratorEnd();
  return n;
}

/* ===== KLASIFIKASI GATEWAY ===== */
void saveGatewayPath(const String &path) {
  gatewayPath = path;
  prefs.putString("path", path);
}

void forgetGatewayPath() {
  gatewayPath = "";
  roomCount = 0;
  pendingRegistered = false;
  prefs.remove("path");
}

// Cari node gateway yang gatewayMac-nya = MAC gateway ini (diisi admin lewat modal "Klasifikasikan Gateway")
ReadResult discoverGatewayPath() {
  String locKeys[MAX_KEYS];
  int nLoc = readShallowKeys("locations", locKeys, MAX_KEYS);
  if (nLoc < 0) return READ_ERROR;

  for (int i = 0; i < nLoc; i++) {
    String locPath = "locations/" + locKeys[i];
    String floorKeys[MAX_KEYS];
    int nFloor = readShallowKeys(locPath, floorKeys, MAX_KEYS);
    if (nFloor < 0) return READ_ERROR;

    for (int j = 0; j < nFloor; j++) {
      if (floorKeys[j] == "name" || floorKeys[j] == "address") continue;
      String floorPath = locPath + "/" + floorKeys[j];
      String gwKeys[MAX_KEYS];
      int nGw = readShallowKeys(floorPath, gwKeys, MAX_KEYS);
      if (nGw < 0) return READ_ERROR;

      for (int k = 0; k < nGw; k++) {
        if (gwKeys[k] == "createdAt") continue;
        String gwPath = floorPath + "/" + gwKeys[k];
        String mac;
        ReadResult res = readString(gwPath + "/gatewayMac", mac);
        if (res == READ_ERROR) return READ_ERROR;
        if (res == READ_OK && mac.equalsIgnoreCase(gatewayMac)) {
          saveGatewayPath(gwPath);
          Serial.printf("[GATEWAY] Terklasifikasi di %s\n", gwPath.c_str());
          return READ_OK;
        }
      }
    }
  }
  return READ_MISSING;
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

/* ===== PERINTAH KE DOORLOCK ===== */
// TODO: kirim lewat ESP-NOW ke doorlock setelah pairing HMAC (Firmware/Gateway) digabung ke firmware ini
void sendDoorlockCommand(const Room &r, const char *command) {
  Serial.printf("[CMD] %s -> %s (doorlock %s)\n", command, r.key.c_str(),
                r.doorlockMac.length() ? r.doorlockMac.c_str() : "belum terpasang");
}

void onRoomStatusChanged(const Room &r) {
  sendDoorlockCommand(r, r.status == "unlocked" ? "UNLOCK" : "LOCK");
}

void onRfidAccessChanged(const Room &r) {
  sendDoorlockCommand(r, r.rfidAccess ? "RFID_ALLOW" : "RFID_BLOCK");
}

/* ===== SINKRONISASI KAMAR ===== */
Room *findRoomByKey(const String &key) {
  for (int i = 0; i < roomCount; i++) {
    if (rooms[i].key == key) return &rooms[i];
  }
  return nullptr;
}

Room *findRoomByDoorlock(const String &mac) {
  for (int i = 0; i < roomCount; i++) {
    if (rooms[i].doorlockMac.equalsIgnoreCase(mac)) return &rooms[i];
  }
  return nullptr;
}

// Baca ulang daftar kamar di bawah gateway ini. Kamar = semua child selain gatewayMac/createdAt (sama seperti getRooms() di website).
void refreshRooms() {
  if (!useFixedPath) {
    String mac;
    ReadResult res = readString(gatewayPath + "/gatewayMac", mac);
    if (res == READ_ERROR) { printFirebaseError("Cek gatewayMac"); return; }
    if (res == READ_MISSING || !mac.equalsIgnoreCase(gatewayMac)) {
      Serial.println("[GATEWAY] Node gateway dihapus/diganti admin, kembali ke mode menunggu klasifikasi.");
      forgetGatewayPath();
      return;
    }
  }

  String keys[MAX_KEYS];
  int nKeys = readShallowKeys(gatewayPath, keys, MAX_KEYS);
  if (nKeys < 0) { printFirebaseError("Baca daftar kamar"); return; }

  Room fresh[MAX_ROOMS];
  int freshCount = 0;
  for (int i = 0; i < nKeys && freshCount < MAX_ROOMS; i++) {
    if (keys[i] == "gatewayMac" || keys[i] == "createdAt") continue;

    String roomPath = gatewayPath + "/" + keys[i];
    Room r;
    r.key = keys[i];
    r.rfidAccess = true;
    if (readString(roomPath + "/doorlockMac", r.doorlockMac) == READ_ERROR) return;
    if (readString(roomPath + "/status", r.status) == READ_ERROR) return;
    if (readBool(roomPath + "/rfidAccess", r.rfidAccess) == READ_ERROR) return;

    Room *old = findRoomByKey(r.key);
    if (old && old->status != r.status) onRoomStatusChanged(r);
    if (old && old->rfidAccess != r.rfidAccess) onRfidAccessChanged(r);

    fresh[freshCount++] = r;
  }

  for (int i = 0; i < freshCount; i++) rooms[i] = fresh[i];
  roomCount = freshCount;
  if (pollIndex >= roomCount) pollIndex = 0;

  Serial.printf("[GATEWAY] %d kamar tersinkron.\n", roomCount);
}

// Cek status 1 kamar per panggilan secara bergiliran, supaya loop() tidak tertahan lama
void pollNextRoom() {
  if (roomCount == 0) return;

  Room &r = rooms[pollIndex];
  String roomPath = gatewayPath + "/" + r.key;

  String status;
  if (readString(roomPath + "/status", status) == READ_OK && status != r.status) {
    r.status = status;
    onRoomStatusChanged(r);
  }

  if (pollRound % RFID_POLL_EVERY == 0) {
    bool rfid;
    if (readBool(roomPath + "/rfidAccess", rfid) == READ_OK && rfid != r.rfidAccess) {
      r.rfidAccess = rfid;
      onRfidAccessChanged(r);
    }
  }

  if (++pollIndex >= roomCount) {
    pollIndex = 0;
    pollRound++;
  }
}

/* ===== LAPORAN DARI DOORLOCK KE FIREBASE ===== */
// Dipanggil begitu pairing HMAC sebuah doorlock berhasil -> muncul di panel admin "Doorlock Menunggu Klasifikasi"
void reportDoorlockPaired(const String &doorlockMac) {
  FirebaseJson json;
  json.set("gatewayMac", gatewayMac);
  json.set("pairedAt/.sv", "timestamp");
  if (Firebase.RTDB.setJSON(&fbdo, "pendingDevices/" + doorlockMac, &json)) {
    Serial.printf("[GATEWAY] Doorlock %s terdaftar di pendingDevices.\n", doorlockMac.c_str());
  } else {
    printFirebaseError("Daftar pendingDevices");
  }
}

// Dipanggil saat doorlock membuka/mengunci sendiri (mis. tap RFID), supaya status di dashboard ikut update
void reportDoorEvent(const String &doorlockMac, bool unlocked, const char *by) {
  Room *r = findRoomByDoorlock(doorlockMac);
  if (!r) {
    Serial.printf("[GATEWAY] Doorlock %s belum terpasang di kamar manapun pada gateway ini.\n", doorlockMac.c_str());
    return;
  }

  // Update status lokal duluan supaya polling tidak mengirim balik perintah yang sama ke doorlock
  r->status = unlocked ? "unlocked" : "locked";
  String roomPath = gatewayPath + "/" + r->key;

  FirebaseJson update;
  update.set("status", r->status);
  if (unlocked) update.set("unlockedAt/.sv", "timestamp");
  if (!Firebase.RTDB.updateNode(&fbdo, roomPath, &update)) { printFirebaseError("Update status kamar"); return; }
  if (!unlocked) Firebase.RTDB.deleteNode(&fbdo, roomPath + "/unlockedAt");

  // Riwayat (history) sengaja tidak ditulis gateway — dicatat oleh website saja
  Serial.printf("[GATEWAY] %s %s oleh %s.\n", r->key.c_str(), r->status.c_str(), by);
}

/* ===== PERINTAH SERIAL (untuk uji coba sebelum ESP-NOW tersambung) ===== */
// pair AA:BB:CC:DD:EE:FF    -> simulasi pairing doorlock berhasil
// unlock AA:BB:CC:DD:EE:FF  -> simulasi doorlock dibuka lewat RFID
// lock AA:BB:CC:DD:EE:FF    -> simulasi doorlock terkunci
// rooms                     -> tampilkan daftar kamar yang tersinkron
// reset                     -> lupakan lokasi gateway & cari ulang
void handleSerialCommand() {
  if (!Serial.available()) return;

  String line = Serial.readStringUntil('\n');
  line.trim();
  int space = line.indexOf(' ');
  String command = space < 0 ? line : line.substring(0, space);
  String arg = space < 0 ? "" : line.substring(space + 1);
  arg.trim();
  arg.toUpperCase();

  if (command == "rooms") {
    Serial.printf("Gateway %s @ %s\n", gatewayMac.c_str(), gatewayPath.length() ? gatewayPath.c_str() : "(belum diklasifikasikan)");
    for (int i = 0; i < roomCount; i++) {
      Serial.printf("  %s | %s | RFID %s | doorlock %s\n", rooms[i].key.c_str(), rooms[i].status.c_str(),
                    rooms[i].rfidAccess ? "izin" : "blokir", rooms[i].doorlockMac.length() ? rooms[i].doorlockMac.c_str() : "-");
    }
  } else if (command == "reset") {
    if (useFixedPath) { Serial.println("GATEWAY_PATH diisi manual, ubah langsung di kode."); return; }
    forgetGatewayPath();
    lastDiscoveryAt = 0;
    Serial.println("Lokasi gateway direset.");
  } else if (command == "pair" || command == "unlock" || command == "lock") {
    if (arg.length() != 17) { Serial.println("Format MAC: AA:BB:CC:DD:EE:FF"); return; }
    if (gatewayPath.isEmpty()) { Serial.println("Gateway belum diklasifikasikan admin."); return; }
    if (command == "pair") reportDoorlockPaired(arg);
    else reportDoorEvent(arg, command == "unlock", "Doorlock (RFID)");
  } else if (command.length()) {
    Serial.println("Perintah: pair|unlock|lock <MAC>, rooms, reset");
  }
}

/* ===== SETUP & LOOP ===== */
void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Menghubungkan WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(500);
  }
  Serial.printf("\nWiFi terhubung, IP %s\n", WiFi.localIP().toString().c_str());
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  connectWiFi();
  gatewayMac = WiFi.macAddress();
  Serial.printf("MAC gateway: %s\n", gatewayMac.c_str());

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

  if (gatewayPath.length()) {
    Serial.printf("[GATEWAY] Lokasi tersimpan: %s, memverifikasi...\n", gatewayPath.c_str());
    refreshRooms();  // otomatis forgetGatewayPath() kalau gatewayMac di path itu sudah tidak cocok
    lastRoomRefreshAt = millis();
  }
}

void loop() {
  handleSerialCommand();
  if (!Firebase.ready()) return;

  unsigned long now = millis();

  if (gatewayPath.isEmpty()) {
    if (lastDiscoveryAt == 0 || now - lastDiscoveryAt >= DISCOVERY_RETRY_MS) {
      lastDiscoveryAt = now;
      ReadResult res = discoverGatewayPath();
      if (res == READ_OK) {
        refreshRooms();
        lastRoomRefreshAt = millis();
      } else if (res == READ_MISSING && !pendingRegistered) {
        registerPendingGateway();
      } else if (res == READ_ERROR) {
        printFirebaseError("Cari lokasi gateway");
      }
    }
    return;
  }

  if (now - lastRoomRefreshAt >= ROOM_REFRESH_MS) {
    lastRoomRefreshAt = now;
    refreshRooms();
    return;
  }

  if (now - lastPollAt >= STATUS_POLL_MS) {
    lastPollAt = now;
    pollNextRoom();
  }
}

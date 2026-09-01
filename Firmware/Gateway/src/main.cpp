#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_now.h>

const char* WIFI_SSID = "Nge";
const char* WIFI_PASSWORD = "ngengenge";

const char* DATABASE_URL = "https://isk-project-9501f-default-rtdb.firebaseio.com";
const unsigned long FIREBASE_READ_INTERVAL = 2000;

typedef struct {
  char message[32];
} DoorCommand;

DoorCommand outgoingCommand;
DoorCommand incomingData;

unsigned long lastFirebaseRead = 0;
char lastCommand[32] = "";

uint8_t doorlockAddress[6] = {0};
volatile bool paired = false;

void sendAck(const uint8_t *mac_addr) {
  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, mac_addr, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;
  esp_now_add_peer(&peerInfo);

  DoorCommand ack;
  memset(&ack, 0, sizeof(ack));
  strcpy(ack.message, "GATEWAY_ACK");
  esp_now_send(mac_addr, (uint8_t*)&ack, sizeof(ack));
}

void OnDataRecv(const uint8_t *mac_addr, const uint8_t *incomingBytes, int len) {
  memcpy(&incomingData, incomingBytes, sizeof(incomingData));

  if (!paired) {
    if (strcmp(incomingData.message, "DOORLOCK_HELLO") == 0) {
      memcpy(doorlockAddress, mac_addr, 6);
      sendAck(mac_addr);
      paired = true;
    }
    return;
  }

  Serial.print("Status dari Doorlock: ");
  Serial.println(incomingData.message);
}

void OnDataSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
  Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Kirim ke Doorlock: SUKSES" : "Kirim ke Doorlock: GAGAL");
}

void sendDoorCommand(const char* command) {
  memset(&outgoingCommand, 0, sizeof(outgoingCommand));
  strncpy(outgoingCommand.message, command, sizeof(outgoingCommand.message) - 1);
  esp_now_send(doorlockAddress, (uint8_t*)&outgoingCommand, sizeof(outgoingCommand));
}

void checkFirebaseCommand() {
  HTTPClient http;
  http.begin(String(DATABASE_URL) + "/Doorlock.json");

  int httpCode = http.GET();

  if (httpCode == HTTP_CODE_OK) {
    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, http.getString());

    if (!error) {
      const char* command = doc["Control"]["command"] | "";

      if ((strcmp(command, "LOCK") == 0 || strcmp(command, "UNLOCK") == 0) &&
          strcmp(command, lastCommand) != 0) {
        strncpy(lastCommand, command, sizeof(lastCommand) - 1);

        Serial.print("Status Firebase berubah: ");
        Serial.println(command);

        sendDoorCommand(command);
      }
    } else {
      Serial.print("JSON parse error: ");
      Serial.println(error.c_str());
    }
  } else {
    Serial.print("Firebase GET gagal: ");
    Serial.println(httpCode);
  }

  http.end();
}

void pairing() {
  Serial.println("Pairing...");

  unsigned long lastPrint = millis();
  while (!paired) {
    if (millis() - lastPrint >= 1000) {
      lastPrint = millis();
      Serial.println("Pairing...");
    }
    delay(10);
  }

  Serial.printf(
    "Pairing selesai, Doorlock: %02X:%02X:%02X:%02X:%02X:%02X\n",
    doorlockAddress[0], doorlockAddress[1], doorlockAddress[2],
    doorlockAddress[3], doorlockAddress[4], doorlockAddress[5]
  );
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Menghubungkan ke WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(500);
  }
  Serial.println();
  Serial.print("WiFi terhubung, IP: ");
  Serial.println(WiFi.localIP());

  WiFi.setSleep(false);
}

void connectFirebase() {
  Serial.print("Menghubungkan ke Firebase");

  int httpCode;
  do {
    HTTPClient http;
    http.begin(String(DATABASE_URL) + "/Doorlock.json");
    httpCode = http.GET();
    http.end();

    if (httpCode != HTTP_CODE_OK) {
      Serial.print(".");
      delay(500);
    }
  } while (httpCode != HTTP_CODE_OK);

  Serial.println();
  Serial.println("Firebase terhubung");
}

void setup() {
  Serial.begin(115200);

  connectWiFi();
  connectFirebase();

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init gagal");
    return;
  }

  esp_now_register_recv_cb(OnDataRecv);
  esp_now_register_send_cb(OnDataSent);

  pairing();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (millis() - lastFirebaseRead >= FIREBASE_READ_INTERVAL) {
    lastFirebaseRead = millis();
    checkFirebaseCommand();
  }
}

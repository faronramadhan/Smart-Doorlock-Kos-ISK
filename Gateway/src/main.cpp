#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_now.h>

const char* WIFI_SSID = "Nge";
const char* WIFI_PASSWORD = "ngengenge";

const char* DATABASE_URL = "https://isk-project-9501f-default-rtdb.firebaseio.com";
const unsigned long FIREBASE_READ_INTERVAL = 2000;

uint8_t doorlockAddress[] = { 0x14, 0x63, 0x93, 0x8D, 0xA2, 0x84 };

typedef struct {
  char message[32];
} DoorCommand;

DoorCommand outgoingCommand;
DoorCommand incomingStatus;

unsigned long lastFirebaseRead = 0;
char lastCommand[32] = "";

void OnDataRecv(const uint8_t *mac_addr, const uint8_t *incomingData, int len) {
  memcpy(&incomingStatus, incomingData, sizeof(incomingStatus));
  Serial.print("Status dari Doorlock: ");
  Serial.println(incomingStatus.message);
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

        Serial.print("Command baru dari Firebase: ");
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

void setup() {
  Serial.begin(115200);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Menghubungkan ke WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(500);
  }
  Serial.println();
  Serial.print("WiFi tersambung, IP: ");
  Serial.println(WiFi.localIP());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init gagal");
    return;
  }

  esp_now_register_recv_cb(OnDataRecv);
  esp_now_register_send_cb(OnDataSent);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, doorlockAddress, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  esp_err_t result = esp_now_add_peer(&peerInfo);
  Serial.print("Doorlock Peer: ");
  Serial.println(result == ESP_OK || result == ESP_ERR_ESPNOW_EXIST ? "OK" : "GAGAL");
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

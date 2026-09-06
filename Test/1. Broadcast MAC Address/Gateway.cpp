#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>

bool listening = false;
bool connected = false;

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (!listening) return;

  char macStr[18];
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.print("MAC terdeteksi: ");
  Serial.println(macStr);

  if (!connected) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, mac, 6);
    esp_now_add_peer(&peer);
    connected = true;

    Serial.print("Connect ke: ");
    Serial.println(macStr);
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);
}

void loop() {
  if (!listening && Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Pairing") {
      listening = true;
      Serial.println("Masuk mode listen...");
    }
  }
}

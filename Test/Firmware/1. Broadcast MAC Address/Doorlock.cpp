#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>

uint8_t broadcastAddress[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
bool broadcasting = false;

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_now_init();

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddress, 6);
  esp_now_add_peer(&peer);
}

void loop() {
  if (!broadcasting && Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Pairing") {
      Serial.println(WiFi.macAddress());
      broadcasting = true;
    }
  }

  if (broadcasting) {
    String mac = WiFi.macAddress();
    esp_now_send(broadcastAddress, (uint8_t*)mac.c_str(), mac.length() + 1);
    Serial.println("Pairing...");
    delay(500);
  }
}

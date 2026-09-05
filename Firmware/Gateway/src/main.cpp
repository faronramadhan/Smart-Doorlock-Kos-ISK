#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  Serial.print("Broadcast diterima, isi: ");
  Serial.println((const char*)data);
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);
}

void loop() {
}
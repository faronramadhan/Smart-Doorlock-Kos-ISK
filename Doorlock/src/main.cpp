#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include "esp_wifi.h"

#define M_POS 9
#define M_NEG 8

#define DRV_IN1 6
#define DRV_IN2 7
#define DRV_SLEEP 5

#define WIFI_CHANNEL 11

uint8_t gatewayAddress[] = { 0xEC, 0xE3, 0x34, 0x1A, 0x87, 0x8C };

typedef struct {
  char message[32];
} DoorCommand;

DoorCommand receivedCommand;

volatile bool doorLocked = true;

void OnDataRecv(const uint8_t *mac_addr, const uint8_t *incomingData, int len) {
  memcpy(&receivedCommand, incomingData, sizeof(receivedCommand));

  Serial.print("Status dari Gateway: ");
  Serial.println(receivedCommand.message);

  if (strcmp(receivedCommand.message, "LOCK") == 0) {
    doorLocked = true;
  } else if (strcmp(receivedCommand.message, "UNLOCK") == 0) {
    doorLocked = false;
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(M_POS, INPUT);
  pinMode(M_NEG, INPUT);

  pinMode(DRV_IN1, OUTPUT);
  pinMode(DRV_IN2, OUTPUT);
  pinMode(DRV_SLEEP, OUTPUT);

  digitalWrite(DRV_SLEEP, HIGH);

  WiFi.mode(WIFI_STA);
  delay(500);

  Serial.print("MAC Address : ");
  Serial.println(WiFi.macAddress());

  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW INIT FAILED");
    return;
  }

  esp_now_register_recv_cb(OnDataRecv);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, gatewayAddress, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  esp_err_t result = esp_now_add_peer(&peerInfo);

  Serial.print("Gateway Peer: ");
  if (result == ESP_OK) {
    Serial.println("ADDED");
  } else if (result == ESP_ERR_ESPNOW_EXIST) {
    Serial.println("ALREADY EXISTS");
  } else {
    Serial.print("FAILED ");
    Serial.println(result);
  }
}

void loop() {
  int MPosStatus  = digitalRead(M_POS);
  int MNegStatus = digitalRead(M_NEG);

  digitalWrite(DRV_IN1, MPosStatus);
  digitalWrite(DRV_IN2, MNegStatus);

  Serial.print("M+: ");
  Serial.print(MPosStatus);
  Serial.print(", ");
  Serial.print("M-: ");
  Serial.println(MNegStatus);

  delay(200);
}

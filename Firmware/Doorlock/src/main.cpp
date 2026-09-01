#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include "esp_wifi.h"

#define M_POS 9
#define M_NEG 8

#define DRV_IN1 6
#define DRV_IN2 7
#define DRV_SLEEP 5

#define PAIRING_CHANNEL_TIMEOUT 300

uint8_t broadcastAddress[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };

typedef struct {
  char message[32];
} DoorCommand;

DoorCommand receivedCommand;
DoorCommand helloMessage;

volatile bool doorLocked = true;
volatile bool paired = false;

void OnDataRecv(const uint8_t *mac_addr, const uint8_t *incomingData, int len) {
  DoorCommand incoming;
  memcpy(&incoming, incomingData, sizeof(incoming));

  if (!paired) {
    if (strcmp(incoming.message, "GATEWAY_ACK") == 0) {
      paired = true;
    }
    return;
  }

  receivedCommand = incoming;

  Serial.print("Status dari Gateway: ");
  Serial.println(receivedCommand.message);

  if (strcmp(receivedCommand.message, "LOCK") == 0) {
    doorLocked = true;
  } else if (strcmp(receivedCommand.message, "UNLOCK") == 0) {
    doorLocked = false;
  }
}

void broadcastHello() {
  memset(&helloMessage, 0, sizeof(helloMessage));
  strcpy(helloMessage.message, "DOORLOCK_HELLO");
  esp_now_send(broadcastAddress, (uint8_t*)&helloMessage, sizeof(helloMessage));
}

void pairing() {
  uint8_t channel = 1;

  while (!paired) {
    if (channel == 1) {
      Serial.println("Pairing...");
    }

    esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
    broadcastHello();

    unsigned long waitStart = millis();
    while (!paired && millis() - waitStart < PAIRING_CHANNEL_TIMEOUT) {
      delay(10);
    }

    channel = (channel % 13) + 1;
  }

  Serial.print("Pairing selesai, Channel: ");
  Serial.println(WiFi.channel());
}

void setup() {
  Serial.begin(115200);

  pinMode(M_POS, INPUT);
  pinMode(M_NEG, INPUT);

  pinMode(DRV_IN1, OUTPUT);
  pinMode(DRV_IN2, OUTPUT);
  pinMode(DRV_SLEEP, OUTPUT);

  digitalWrite(DRV_SLEEP, doorLocked ? LOW : HIGH);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  Serial.print("MAC Address : ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW INIT FAILED");
    return;
  }

  esp_now_register_recv_cb(OnDataRecv);

  esp_now_peer_info_t broadcastPeer = {};
  memcpy(broadcastPeer.peer_addr, broadcastAddress, 6);
  broadcastPeer.channel = 0;
  broadcastPeer.encrypt = false;
  esp_now_add_peer(&broadcastPeer);

  pairing();
}

void loop() {
  digitalWrite(DRV_SLEEP, doorLocked ? LOW : HIGH);

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

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <mbedtls/md.h>

uint8_t broadcastAddress[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 }; // Kos ISK, Doorlock, HW v0, SW v0
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

bool broadcasting = false;
bool done = false;

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (!broadcasting || done || len != sizeof(AuthMessage)) return;

  const AuthMessage *challenge = (const AuthMessage*)data;

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  esp_now_add_peer(&peer);

  AuthMessage response;
  response.nonce = challenge->nonce;
  computeProof(challenge->nonce, response.proof);
  esp_now_send(mac, (uint8_t*)&response, sizeof(response));

  broadcasting = false;
  done = true;

  Serial.print("Challenge diterima (nonce=0x");
  Serial.print(challenge->nonce, HEX);
  Serial.println("), proof terkirim.");
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddress, 6);
  esp_now_add_peer(&peer);
}

void loop() {
  if (!broadcasting && !done && Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Pairing") {
      broadcasting = true;
      Serial.println("Broadcast tag dimulai...");
    }
  }

  if (broadcasting) {
    esp_now_send(broadcastAddress, (uint8_t*)TAG, sizeof(TAG));
    Serial.println("Pairing...");
    delay(500);
  }
}

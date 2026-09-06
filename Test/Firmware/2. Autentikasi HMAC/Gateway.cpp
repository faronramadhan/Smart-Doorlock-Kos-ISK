#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_system.h>
#include <mbedtls/md.h>

const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 }; // Kos ISK, Doorlock, HW v0, SW v0
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

#define MAX_QUEUE 16
#define CHALLENGE_TIMEOUT 2000

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

bool listening = false;

uint8_t queueMac[MAX_QUEUE][6];
int queueCount = 0;

uint8_t currentMac[6];
uint32_t currentNonce = 0;
unsigned long challengeSentAt = 0;
bool awaitingResponse = false;

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void printMac(const uint8_t *mac) {
  char macStr[18];
  snprintf(macStr, sizeof(macStr), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  Serial.print(macStr);
}

bool alreadyQueued(const uint8_t *mac) {
  for (int i = 0; i < queueCount; i++) {
    if (memcmp(queueMac[i], mac, 6) == 0) return true;
  }
  return false;
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (!listening) return;

  if (len == 4 && memcmp(data, TAG, 4) == 0) {
    if (awaitingResponse && memcmp(mac, currentMac, 6) == 0) return;
    if (alreadyQueued(mac)) return;
    if (queueCount >= MAX_QUEUE) return;

    memcpy(queueMac[queueCount], mac, 6);
    queueCount++;

    Serial.print("Tag cocok dari ");
    printMac(mac);
    Serial.println(", masuk antrian.");
    return;
  }

  if (len == sizeof(AuthMessage) && awaitingResponse) {
    if (memcmp(mac, currentMac, 6) != 0) return;

    const AuthMessage *reply = (const AuthMessage*)data;
    if (reply->nonce != currentNonce) return;

    uint8_t expectedProof[3];
    computeProof(currentNonce, expectedProof);

    Serial.print("Balasan dari ");
    printMac(mac);
    Serial.print(" -> ");

    if (memcmp(reply->proof, expectedProof, 3) == 0) {
      Serial.println("VALID, peer didaftarkan.");
    } else {
      Serial.println("TIDAK VALID, ditolak.");
      esp_now_del_peer(currentMac);
    }

    awaitingResponse = false;
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

  if (awaitingResponse && millis() - challengeSentAt > CHALLENGE_TIMEOUT) {
    Serial.print("Timeout menunggu balasan dari ");
    printMac(currentMac);
    Serial.println(".");
    esp_now_del_peer(currentMac);
    awaitingResponse = false;
  }

  if (listening && !awaitingResponse && queueCount > 0) {
    memcpy(currentMac, queueMac[0], 6);
    for (int i = 1; i < queueCount; i++) {
      memcpy(queueMac[i - 1], queueMac[i], 6);
    }
    queueCount--;

    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, currentMac, 6);
    esp_now_add_peer(&peer);

    currentNonce = esp_random();
    AuthMessage challenge = { currentNonce, {0, 0, 0} };
    esp_now_send(currentMac, (uint8_t*)&challenge, sizeof(challenge));

    challengeSentAt = millis();
    awaitingResponse = true;

    Serial.print("Challenge dikirim ke ");
    printMac(currentMac);
    Serial.print(" (nonce=0x");
    Serial.print(currentNonce, HEX);
    Serial.println(").");
  }
}

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_system.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <Preferences.h>

#define WIFI_CHANNEL 1

#define MAX_PEERS 20
#define MAX_QUEUE 20
#define MSG_DISCONNECT 2
#define MSG_PING 3
#define MSG_PONG 4
#define CHALLENGE_TIMEOUT 2000

const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 };
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

Preferences prefs;

bool listening = true;

uint8_t queueMac[MAX_QUEUE][6];
int queueCount = 0;

uint8_t currentMac[6];
uint32_t currentNonce = 0;
unsigned long challengeSentAt = 0;
bool awaitingResponse = false;

int peerCount = 0;
uint8_t peers[MAX_PEERS][6];

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void savePeers() {
  prefs.putUChar("count", peerCount);
  prefs.putBytes("macs", peers, peerCount * 6);
}

void loadPeers() {
  peerCount = prefs.getUChar("count", 0);
  if (peerCount > MAX_PEERS) peerCount = 0;
  prefs.getBytes("macs", peers, peerCount * 6);

  for (int i = 0; i < peerCount; i++) {
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, peers[i], 6);
    esp_now_add_peer(&peer);
  }

  Serial.printf("Peer di-load: %d\n", peerCount);
}

void resetPeers() {
  for (int i = 0; i < peerCount; i++) {
    esp_now_del_peer(peers[i]);
  }
  peerCount = 0;
  savePeers();
  Serial.println("Semua peer dihapus.");
}

void printStatus() {
  Serial.printf("Peer terhubung: %d/%d\n", peerCount, MAX_PEERS);
  for (int i = 0; i < peerCount; i++) {
    Serial.printf("%02X:%02X:%02X:%02X:%02X:%02X\n",
                  peers[i][0], peers[i][1], peers[i][2], peers[i][3], peers[i][4], peers[i][5]);
  }
}

void removePeer(const uint8_t *mac) {
  for (int i = 0; i < peerCount; i++) {
    if (memcmp(peers[i], mac, 6) != 0) continue;

    esp_now_del_peer(mac);
    for (int j = i; j < peerCount - 1; j++) {
      memcpy(peers[j], peers[j + 1], 6);
    }
    peerCount--;
    savePeers();

    Serial.printf("Peer terputus: %02X:%02X:%02X:%02X:%02X:%02X (%d/%d)\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], peerCount, MAX_PEERS);
    return;
  }
}

bool alreadyQueued(const uint8_t *mac) {
  for (int i = 0; i < queueCount; i++) {
    if (memcmp(queueMac[i], mac, 6) == 0) return true;
  }
  return false;
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (len == 1 && data[0] == MSG_DISCONNECT) {
    removePeer(mac);
    return;
  }

  if (len == 1 && data[0] == MSG_PING) {
    uint8_t pong = MSG_PONG;
    esp_now_send(mac, &pong, sizeof(pong));
    return;
  }

  if (!listening) return;

  if (len == 4 && memcmp(data, TAG, 4) == 0) {
    if (esp_now_is_peer_exist(mac) || alreadyQueued(mac)) return;
    if (awaitingResponse && memcmp(mac, currentMac, 6) == 0) return;
    if (peerCount >= MAX_PEERS || queueCount >= MAX_QUEUE) return;

    memcpy(queueMac[queueCount], mac, 6);
    queueCount++;

    Serial.printf("Kandidat terdeteksi: %02X:%02X:%02X:%02X:%02X:%02X, masuk antrian.\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return;
  }

  if (len == sizeof(AuthMessage) && awaitingResponse && memcmp(mac, currentMac, 6) == 0) {
    const AuthMessage *reply = (const AuthMessage*)data;
    if (reply->nonce != currentNonce) return;

    uint8_t expectedProof[3];
    computeProof(currentNonce, expectedProof);

    if (memcmp(reply->proof, expectedProof, 3) == 0) {
      memcpy(peers[peerCount], currentMac, 6);
      peerCount++;
      savePeers();

      Serial.printf("Valid, bonding permanen: %02X:%02X:%02X:%02X:%02X:%02X (%d/%d)\n",
                    currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5],
                    peerCount, MAX_PEERS);
    } else {
      esp_now_del_peer(currentMac);
      Serial.printf("Tidak valid, ditolak: %02X:%02X:%02X:%02X:%02X:%02X\n",
                    currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5]);
    }

    awaitingResponse = false;
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);

  prefs.begin("gateway", false);
  loadPeers();
}

void loop() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Reset") {
      resetPeers();
    } else if (command == "Status") {
      printStatus();
    }
  }

  if (awaitingResponse && millis() - challengeSentAt > CHALLENGE_TIMEOUT) {
    esp_now_del_peer(currentMac);
    Serial.printf("Timeout menunggu balasan dari %02X:%02X:%02X:%02X:%02X:%02X.\n",
                  currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5]);
    awaitingResponse = false;
  }

  if (listening && !awaitingResponse && queueCount > 0 && peerCount < MAX_PEERS) {
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

    Serial.printf("Challenge dikirim ke %02X:%02X:%02X:%02X:%02X:%02X (nonce=0x%08X).\n",
                  currentMac[0], currentMac[1], currentMac[2], currentMac[3], currentMac[4], currentMac[5],
                  currentNonce);
  }
}

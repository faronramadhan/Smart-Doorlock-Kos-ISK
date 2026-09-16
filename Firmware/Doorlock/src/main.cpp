#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <Preferences.h>

#define MSG_DISCONNECT 2
#define MSG_PING 3
#define PAIRING_TIMEOUT 60000
#define PING_INTERVAL 1000
#define WIFI_CHANNEL 1

uint8_t broadcastAddress[] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
const uint8_t TAG[4] = { 0x00, 0x00, 0x00, 0x00 };
const uint8_t SECRET_KEY[] = "ISK-Doorlock-V0.0";

typedef struct {
  uint32_t nonce;
  uint8_t proof[3];
} AuthMessage;

typedef struct {
  uint16_t frame_ctrl;
  uint16_t duration_id;
  uint8_t addr1[6];
  uint8_t addr2[6];
  uint8_t addr3[6];
  uint16_t sequence_ctrl;
} wifi_ieee80211_mac_hdr_t;

Preferences prefs;

bool broadcasting = false;
bool paired = false;
uint8_t gatewayMac[6];
unsigned long broadcastStartedAt = 0;
unsigned long lastPingAt = 0;

void onSniff(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (!paired || type != WIFI_PKT_MGMT) return;

  wifi_promiscuous_pkt_t *pkt = (wifi_promiscuous_pkt_t*)buf;
  wifi_ieee80211_mac_hdr_t *hdr = (wifi_ieee80211_mac_hdr_t*)pkt->payload;

  if (memcmp(hdr->addr2, gatewayMac, 6) != 0) return;

  Serial.printf("RSSI Gateway: %d dBm\n", pkt->rx_ctrl.rssi);
}

void computeProof(uint32_t nonce, uint8_t *proofOut) {
  uint8_t fullHash[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, SECRET_KEY, sizeof(SECRET_KEY) - 1, (uint8_t*)&nonce, sizeof(nonce), fullHash);
  memcpy(proofOut, fullHash, 3);
}

void savePairing() {
  prefs.putBool("paired", paired);
  prefs.putBytes("gateway", gatewayMac, 6);
}

void loadPairing() {
  paired = prefs.getBool("paired", false);
  if (!paired) return;

  prefs.getBytes("gateway", gatewayMac, 6);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, gatewayMac, 6);
  esp_now_add_peer(&peer);

  esp_wifi_set_promiscuous(true);
  Serial.println("Sudah terhubung ke Gateway (dari penyimpanan).");
}

void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  if (!broadcasting || len != sizeof(AuthMessage)) return;

  const AuthMessage *challenge = (const AuthMessage*)data;

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, mac, 6);
  esp_now_add_peer(&peer);

  AuthMessage response;
  response.nonce = challenge->nonce;
  computeProof(challenge->nonce, response.proof);
  esp_now_send(mac, (uint8_t*)&response, sizeof(response));

  broadcasting = false;
  paired = true;
  memcpy(gatewayMac, mac, 6);
  savePairing();

  esp_wifi_set_promiscuous(true);
  Serial.printf("Challenge diterima (nonce=0x%08X), proof terkirim.\n", challenge->nonce);
}

void disconnectFromGateway() {
  uint8_t signal = MSG_DISCONNECT;
  esp_now_send(gatewayMac, &signal, sizeof(signal));
  esp_now_del_peer(gatewayMac);

  paired = false;
  savePairing();

  esp_wifi_set_promiscuous(false);
  Serial.println("Terputus dari Gateway lama.");
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_now_init();
  esp_now_register_recv_cb(onReceive);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddress, 6);
  esp_now_add_peer(&peer);

  esp_wifi_set_promiscuous_rx_cb(onSniff);

  prefs.begin("doorlock", false);
  loadPairing();
}

void loop() {
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "Pairing" && !broadcasting) {
      if (paired) disconnectFromGateway();

      broadcasting = true;
      broadcastStartedAt = millis();
      Serial.println("Broadcast tag dimulai...");
    }
  }

  if (broadcasting && millis() - broadcastStartedAt > PAIRING_TIMEOUT) {
    broadcasting = false;
    Serial.println("Timeout, kembali ke mode idle.");
  }

  if (broadcasting) {
    esp_now_send(broadcastAddress, (uint8_t*)TAG, sizeof(TAG));
    Serial.println("Pairing...");
    delay(500);
  }

  if (paired && millis() - lastPingAt > PING_INTERVAL) {
    uint8_t ping = MSG_PING;
    esp_now_send(gatewayMac, &ping, sizeof(ping));
    lastPingAt = millis();
  }
}

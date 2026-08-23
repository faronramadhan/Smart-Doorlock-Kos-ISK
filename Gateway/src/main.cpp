#include <WiFi.h>
#include <esp_now.h>

// ========================================
// WIFI
// ========================================

const char* WIFI_SSID = "Nge";
const char* WIFI_PASSWORD = "ngengenge";

// ========================================
// ESP32-C3 MAC
// ========================================

uint8_t doorlockAddress[] =
{
  0x14,
  0x63,
  0x93,
  0x8D,
  0xA2,
  0x84
};

// ========================================
// DATA STRUCTURE
// ========================================

typedef struct
{
  char message[32];
} TestData;

TestData sendData;
TestData receivedData;

// ========================================
// RECEIVE CALLBACK
// ========================================

void OnDataRecv(
  const esp_now_recv_info_t *info,
  const uint8_t *incomingData,
  int len)
{
  Serial.println();
  Serial.println("========================================");
  Serial.println("          ACK FROM ESP32-C3");
  Serial.println("========================================");

  memcpy(
    &receivedData,
    incomingData,
    sizeof(receivedData)
  );

  Serial.print("Message : ");
  Serial.println(receivedData.message);

  Serial.println("========================================");
}

// ========================================
// SEND CALLBACK
// ========================================

void OnDataSent(
  const wifi_tx_info_t *tx_info,
  esp_now_send_status_t status)
{
  Serial.print("Gateway Delivery: ");

  if (status == ESP_NOW_SEND_SUCCESS)
  {
    Serial.println("SUCCESS");
  }
  else
  {
    Serial.println("FAILED");
  }
}

// ========================================
// SEND TEST
// ========================================

void sendTest()
{
  memset(
    &sendData,
    0,
    sizeof(sendData)
  );

  strcpy(
    sendData.message,
    "HELLO_FROM_GATEWAY"
  );

  Serial.println();
  Serial.println("========================================");
  Serial.println("          SEND TO ESP32-C3");
  Serial.println("========================================");

  Serial.print("Message : ");
  Serial.println(sendData.message);

  esp_err_t result =
    esp_now_send(
      doorlockAddress,
      (uint8_t*)&sendData,
      sizeof(sendData)
    );

  Serial.print("Send Result: ");

  if (result == ESP_OK)
  {
    Serial.println("ESP_OK");
  }
  else
  {
    Serial.print("FAILED ");
    Serial.println(result);
  }
}

// ========================================
// SETUP
// ========================================

void setup()
{
  Serial.begin(115200);

  delay(3000);

  Serial.println();
  Serial.println("========================================");
  Serial.println("        ESP32 GATEWAY TWO WAY TEST");
  Serial.println("========================================");

  // ======================================
  // WIFI
  // ======================================

  WiFi.mode(WIFI_STA);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  Serial.print("Connecting");

  while (
    WiFi.status() != WL_CONNECTED
  )
  {
    Serial.print(".");
    delay(500);
  }

  Serial.println();

  Serial.println("WiFi Connected!");

  Serial.print("IP      : ");
  Serial.println(WiFi.localIP());

  Serial.print("Channel : ");
  Serial.println(WiFi.channel());

  Serial.print("MAC     : ");
  Serial.println(WiFi.macAddress());

  // ======================================
  // ESP-NOW
  // ======================================

  if (
    esp_now_init() != ESP_OK
  )
  {
    Serial.println(
      "ESP-NOW INIT FAILED"
    );

    return;
  }

  Serial.println(
    "ESP-NOW INIT SUCCESS"
  );

  // ======================================
  // CALLBACK
  // ======================================

  esp_now_register_recv_cb(
    OnDataRecv
  );

  esp_now_register_send_cb(
    OnDataSent
  );

  // ======================================
  // ADD C3 PEER
  // ======================================

  esp_now_peer_info_t peerInfo = {};

  memcpy(
    peerInfo.peer_addr,
    doorlockAddress,
    6
  );

  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  esp_err_t result =
    esp_now_add_peer(
      &peerInfo
    );

  Serial.print("C3 Peer: ");

  if (result == ESP_OK)
  {
    Serial.println("ADDED");
  }
  else if (
    result == ESP_ERR_ESPNOW_EXIST
  )
  {
    Serial.println("ALREADY EXISTS");
  }
  else
  {
    Serial.print("FAILED ");
    Serial.println(result);
  }

  Serial.println();
  Serial.println("========================================");
  Serial.println("Gateway Ready");
  Serial.println("========================================");

  delay(3000);

  sendTest();
}

// ========================================
// LOOP
// ========================================

void loop()
{
  delay(5000);

  sendTest();
}
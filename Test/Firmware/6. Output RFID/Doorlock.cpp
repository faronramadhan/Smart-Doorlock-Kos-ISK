#include <Arduino.h>

#define M_PLUS_PIN 0
#define M_MINUS_PIN 1

void setup() {
  Serial.begin(115200);
}

void loop() {
  int rawPlus = analogRead(M_PLUS_PIN);
  int rawMinus = analogRead(M_MINUS_PIN);

  float voltPlus = analogReadMilliVolts(M_PLUS_PIN) * 3.0 / 1000.0;
  float voltMinus = analogReadMilliVolts(M_MINUS_PIN) * 3.0 / 1000.0;

  Serial.printf("M+: %d (%.2f V) | M-: %d (%.2f V)\n", rawPlus, voltPlus, rawMinus, voltMinus);
  delay(50);
}

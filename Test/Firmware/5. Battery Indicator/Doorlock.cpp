#include <Arduino.h>

#define BUTTON_PIN 20
#define BAT_EN_PIN 21
#define BAT_IND_PIN 4

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BAT_EN_PIN, OUTPUT);
  digitalWrite(BAT_EN_PIN, LOW);
}

void loop() {
  if (digitalRead(BUTTON_PIN) == LOW) {
    digitalWrite(BAT_EN_PIN, HIGH);
    delay(20);

    int adc = analogReadMilliVolts(BAT_IND_PIN);
    digitalWrite(BAT_EN_PIN, LOW);

    float battery = adc * 3.0 / 1000.0;
    Serial.printf("ADC: %d mV | Baterai: %.2f V\n", adc, battery);

    while (digitalRead(BUTTON_PIN) == LOW);
    delay(50);
  }
}

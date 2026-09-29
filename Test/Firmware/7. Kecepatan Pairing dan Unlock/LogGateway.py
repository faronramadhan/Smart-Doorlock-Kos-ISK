import csv
import msvcrt
import os
import re
import time
from datetime import datetime

import serial
from serial.tools import list_ports

ESP_VID = 0x303A  # USB ESP32-C3
OUTPUT_NAME = "Gateway"  # nama file CSV, tanpa .csv
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), OUTPUT_NAME + ".csv")
RSSI_PATTERN = re.compile(r"RSSI (-?\d+)")


def esc_pressed():
    return msvcrt.kbhit() and msvcrt.getch() == b"\x1b"


def open_port(port):
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = 115200
    ser.timeout = 0.2
    ser.dtr = False
    ser.rts = False
    ser.open()
    return ser


# Cuma Gateway yang membalas perintah "Status", Doorlock tidak membaca Serial
def is_gateway(ser):
    ser.reset_input_buffer()
    ser.write(b"Status\n")
    reply = b""
    end = time.time() + 1
    while time.time() < end:
        reply += ser.read(ser.in_waiting or 1)
    return b"Doorlock terhubung" in reply


def find_gateway():
    while True:
        for port in list_ports.comports():
            if port.vid != ESP_VID:
                continue
            try:
                ser = open_port(port.device)
            except serial.SerialException:
                continue  # sedang dipakai program lain
            if is_gateway(ser):
                return ser
            ser.close()

        end = time.time() + 2
        while time.time() < end:
            if esc_pressed():
                return None
            time.sleep(0.05)


with open(OUTPUT_FILE, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["timestamp", "rssi", "activity_gateway"])
    print("Tekan Esc untuk berhenti.")

    while True:
        print("Mencari Gateway...")
        ser = find_gateway()
        if ser is None:
            break
        print(f"Gateway di {ser.port}")

        try:
            while not esc_pressed():
                line = ser.readline().decode(errors="ignore").strip()
                if not line:
                    continue

                timestamp = datetime.now().isoformat(timespec="milliseconds")
                rssi = RSSI_PATTERN.search(line)
                writer.writerow([timestamp, rssi.group(1) if rssi else "", line])
                f.flush()
                print(timestamp, line)
            ser.close()
            break
        except serial.SerialException:
            ser.close()
            print("Gateway terputus")

import csv
import msvcrt
import os
import re
import time
from datetime import datetime

import serial
from serial.tools import list_ports

ESP_VID = 0x303A  # USB ESP32-C3
MAX_DOORLOCKS = 3
SCAN_INTERVAL_SECONDS = 2
OUTPUT_NAME = "Doorlock"  # nama file CSV, tanpa .csv
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), OUTPUT_NAME + ".csv")
RSSI_PATTERN = re.compile(r"RSSI (-?\d+)")
COLUMNS = [f"doorlock_{i + 1}" for i in range(MAX_DOORLOCKS)]


def esc_pressed():
    return msvcrt.kbhit() and msvcrt.getch() == b"\x1b"


def open_port(port):
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = 115200
    ser.timeout = 0  # baca yang tersedia saja, supaya satu port tidak menahan port lain
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


names = {}    # nomor seri USB (MAC) -> doorlock_n, tetap sama walau COM berubah
conns = {}    # doorlock_n -> Serial
buffers = {}  # doorlock_n -> sisa baris yang belum lengkap


def scan():
    opened = {ser.port for ser in conns.values()}
    for port in list_ports.comports():
        if port.vid != ESP_VID or port.device in opened:
            continue
        if port.serial_number not in names and len(names) >= MAX_DOORLOCKS:
            continue
        try:
            ser = open_port(port.device)
        except serial.SerialException:
            continue  # sedang dipakai program lain, misalnya LogGateway.py
        if is_gateway(ser):
            ser.close()
            continue

        if port.serial_number not in names:
            names[port.serial_number] = COLUMNS[len(names)]
        name = names[port.serial_number]
        conns[name] = ser
        buffers[name] = b""
        print(f"{name} di {port.device} ({port.serial_number})")


with open(OUTPUT_FILE, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["timestamp", "rssi", *COLUMNS])
    print("Tekan Esc untuk berhenti.")

    next_scan = 0
    while not esc_pressed():
        if time.time() >= next_scan:
            scan()
            next_scan = time.time() + SCAN_INTERVAL_SECONDS

        for name, ser in list(conns.items()):
            try:
                buffers[name] += ser.read(ser.in_waiting or 1)
            except serial.SerialException:
                ser.close()
                del conns[name]
                print(f"{name} terputus")
                continue

            while b"\n" in buffers[name]:
                raw, buffers[name] = buffers[name].split(b"\n", 1)
                line = raw.decode(errors="ignore").strip()
                if not line:
                    continue

                timestamp = datetime.now().isoformat(timespec="milliseconds")
                rssi = RSSI_PATTERN.search(line)
                activity = [line if column == name else "" for column in COLUMNS]
                writer.writerow([timestamp, rssi.group(1) if rssi else "", *activity])
                f.flush()
                print(timestamp, name, line)

        time.sleep(0.001)

    for ser in conns.values():
        ser.close()

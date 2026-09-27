import csv
import os
import re
import time
from datetime import datetime

import serial

PORTS = {
    "doorlock_1": "COM29",
    "doorlock_2": "COM30",
    "doorlock_3": "COM32",
}
DURATION_SECONDS = 300
OUTPUT_NAME = "Doorlock"  # nama file CSV, tanpa .csv
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), OUTPUT_NAME + ".csv")
RSSI_PATTERN = re.compile(r"RSSI (-?\d+)")

conns = {}
for name, port in PORTS.items():
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = 115200
    ser.timeout = 0  # baca yang tersedia saja, supaya satu port tidak menahan port lain
    ser.dtr = False
    ser.rts = False
    ser.open()
    conns[name] = ser

buffers = {name: b"" for name in PORTS}

with open(OUTPUT_FILE, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["timestamp", "rssi", *PORTS])

    end_time = time.time() + DURATION_SECONDS
    while time.time() < end_time:
        for name, ser in conns.items():
            buffers[name] += ser.read(ser.in_waiting or 1)

            while b"\n" in buffers[name]:
                raw, buffers[name] = buffers[name].split(b"\n", 1)
                line = raw.decode(errors="ignore").strip()
                if not line:
                    continue

                timestamp = datetime.now().isoformat(timespec="milliseconds")
                rssi = RSSI_PATTERN.search(line)
                activity = [line if column == name else "" for column in PORTS]
                writer.writerow([timestamp, rssi.group(1) if rssi else "", *activity])
                f.flush()
                print(timestamp, name, line)

        time.sleep(0.001)

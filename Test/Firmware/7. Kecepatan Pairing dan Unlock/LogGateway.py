import csv
import os
import re
import time
from datetime import datetime

import serial

PORT = "COM31"
DURATION_SECONDS = 300
OUTPUT_NAME = "Gateway"  # nama file CSV, tanpa .csv
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), OUTPUT_NAME + ".csv")
RSSI_PATTERN = re.compile(r"RSSI (-?\d+)")

ser = serial.Serial()
ser.port = PORT
ser.baudrate = 115200
ser.timeout = 0.2
ser.dtr = False
ser.rts = False
ser.open()

with open(OUTPUT_FILE, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["timestamp", "rssi", "activity_gateway"])

    end_time = time.time() + DURATION_SECONDS
    while time.time() < end_time:
        line = ser.readline().decode(errors="ignore").strip()
        if not line:
            continue

        timestamp = datetime.now().isoformat(timespec="milliseconds")
        rssi = RSSI_PATTERN.search(line)
        writer.writerow([timestamp, rssi.group(1) if rssi else "", line])
        f.flush()
        print(timestamp, line)

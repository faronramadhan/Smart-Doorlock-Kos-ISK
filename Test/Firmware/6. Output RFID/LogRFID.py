import csv
import os
import re
import time
from datetime import datetime

import serial

DURATION_SECONDS = 30
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "OutputRFID.csv")

ser = serial.Serial()
ser.port = "COM29"
ser.baudrate = 115200
ser.timeout = 0.2
ser.dtr = False
ser.rts = False
ser.open()

with open(OUTPUT_FILE, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["timestamp", "m_plus_raw", "m_plus_volt", "m_minus_raw", "m_minus_volt"])

    end_time = time.time() + DURATION_SECONDS
    while time.time() < end_time:
        line = ser.readline().decode(errors="ignore").strip()
        values = re.findall(r"[\d.]+", line)
        if len(values) != 4:
            continue

        timestamp = datetime.now().isoformat(timespec="milliseconds")
        writer.writerow([timestamp, *values])
        print(timestamp, line)

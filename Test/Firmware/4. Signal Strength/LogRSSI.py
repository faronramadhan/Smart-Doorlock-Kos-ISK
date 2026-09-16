import csv
import os
import re
import time
from datetime import datetime

import serial

PORTS = {
    "Doorlock 1": "COM29",
    "Doorlock 2": "COM30",
    "Doorlock 3": "COM31",
}
BAUD_RATE = 115200
DURATION_SECONDS = 60
OUTPUT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "5 Langkah.csv")
RSSI_PATTERN = re.compile(r"RSSI Gateway: (-?\d+) dBm")

conns = {name: serial.Serial(port, BAUD_RATE, timeout=0.2) for name, port in PORTS.items()}
print(f"Terhubung ke {len(conns)} port: {', '.join(PORTS.values())}")

for name, ser in conns.items():
    ser.write(b"Pairing\n")
    print(f"[{name}] Command 'Pairing' terkirim.")

connected = set()
print("Menunggu semua Doorlock connect ke Gateway...")
while len(connected) < len(conns):
    for name, ser in conns.items():
        line = ser.readline().decode(errors="ignore").strip()
        if not line:
            continue
        print(f"[{name}] {line}")
        if name not in connected and RSSI_PATTERN.search(line):
            connected.add(name)
            print(f"[{name}] Connect! ({len(connected)}/{len(conns)})")

print("Semua Doorlock udah connect, mulai logging...")

rows = []
end_time = time.time() + DURATION_SECONDS

while time.time() < end_time:
    for name, ser in conns.items():
        line = ser.readline().decode(errors="ignore").strip()
        match = RSSI_PATTERN.search(line)
        if match:
            rssi = match.group(1)
            timestamp = datetime.now().isoformat(timespec="milliseconds")
            row = [timestamp, name, PORTS[name], rssi]
            rows.append(row)
            print(row)

with open(OUTPUT_FILE, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["timestamp", "doorlock", "port", "rssi_dbm"])
    writer.writerows(rows)

print(f"Selesai. {len(rows)} baris ditulis ke {OUTPUT_FILE}")

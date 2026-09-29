import sys
import time
from datetime import datetime

import serial

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM29"
BAUDRATE = 115200


def now():
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def connect():
    while True:
        try:
            ser = serial.Serial()
            ser.port = PORT
            ser.baudrate = BAUDRATE
            ser.timeout = 0.2
            ser.dtr = False
            ser.rts = False
            ser.open()
            return ser
        except serial.SerialException:
            time.sleep(0.5)


try:
    print(f"{now()} Menunggu {PORT}...")
    while True:
        ser = connect()
        print(f"{now()} {PORT} tersambung")
        try:
            while True:
                line = ser.readline().decode(errors="ignore").strip()
                if line:
                    print(f"{now()} {line}")
        except serial.SerialException:
            ser.close()
            print(f"{now()} {PORT} terputus, menunggu tersambung lagi...")
except KeyboardInterrupt:
    pass

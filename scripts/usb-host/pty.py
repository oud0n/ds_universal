"""試験用のOS疑似シリアル線。機器のプロトコルや実USBは扱わない。"""
import errno
import json
import os
import select
import sys
import time
import tty

master, slave = os.openpty()
tty.setraw(slave)
name = os.ttyname(slave)
os.close(slave)
print(json.dumps({"port": name}), flush=True)
input_bytes = b""
try:
    while True:
        ready, _, _ = select.select([0] + ([master] if master is not None else []), [], [], 0.2)
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            input_bytes += chunk
            while b"\n" in input_bytes:
                line, input_bytes = input_bytes.split(b"\n", 1)
                message = json.loads(line)
                if message.get("unplug"):
                    if master is not None:
                        os.close(master)
                        master = None
                    print(json.dumps({"unplugged": True}), flush=True)
                else:
                    data = bytes(message["bytes"])
                    while data and master is not None:
                        count = os.write(master, data)
                        data = data[count:]
        if master is not None and master in ready:
            try:
                data = os.read(master, 65536)
                if data:
                    print(json.dumps({"bytes": list(data)}), flush=True)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                time.sleep(0.01)  # slaveが開く前/閉じた後
finally:
    if master is not None:
        os.close(master)

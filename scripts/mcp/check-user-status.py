#!/usr/bin/env python3
import json, sqlite3, base64, re
from pathlib import Path

db = Path.home() / 'AppData' / 'Roaming' / 'Windsurf' / 'User' / 'globalStorage' / 'state.vscdb'
conn = sqlite3.connect(str(db))
c = conn.cursor()
c.execute("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'")
row = c.fetchone()
data = json.loads(row[0])

# Decode user status protobuf
if 'userStatusProtoBinaryBase64' in data:
    raw = base64.b64decode(data['userStatusProtoBinaryBase64'])
    print('User status protobuf length:', len(raw))
    strings = re.findall(rb'[\x20-\x7e]{3,}', raw)
    for s in strings:
        txt = s.decode('ascii')
        if any(x in txt.lower() for x in ['plan', 'tier', 'seat', 'token', 'id', 'name']):
            print('  ', txt)

conn.close()

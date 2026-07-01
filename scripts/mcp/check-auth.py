#!/usr/bin/env python3
import json, sqlite3
from pathlib import Path

db = Path.home() / 'AppData' / 'Roaming' / 'Windsurf' / 'User' / 'globalStorage' / 'state.vscdb'
conn = sqlite3.connect(str(db))
c = conn.cursor()
c.execute("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'")
row = c.fetchone()
data = json.loads(row[0])
for k, v in data.items():
    if 'key' in k.lower() or 'token' in k.lower() or 'auth' in k.lower():
        val = str(v)
        if len(val) > 50:
            val = val[:50] + '...'
        print(f'{k}: {val}')
conn.close()

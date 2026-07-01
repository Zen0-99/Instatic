#!/usr/bin/env python3
import json, sqlite3
from pathlib import Path

db = Path.home() / 'AppData' / 'Roaming' / 'Windsurf' / 'User' / 'globalStorage' / 'state.vscdb'
conn = sqlite3.connect(str(db))
c = conn.cursor()
c.execute("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'")
row = c.fetchone()
if row:
    data = json.loads(row[0])
    key = data.get('apiKey', '')
    print(f'apiKey length: {len(key)}')
    print(f'apiKey starts with devin-session-token$: {key.startswith("devin-session-token$")}')
    print(f'apiKey prefix: {key[:30]}...')
    print(f'apiKey suffix: ...{key[-20:]}')
conn.close()

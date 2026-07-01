#!/usr/bin/env python3
import json, sqlite3, base64
from pathlib import Path
from datetime import datetime

db = Path.home() / 'AppData' / 'Roaming' / 'Windsurf' / 'User' / 'globalStorage' / 'state.vscdb'
conn = sqlite3.connect(str(db))
c = conn.cursor()
c.execute("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'")
row = c.fetchone()
data = json.loads(row[0])

jwt = data.get('apiKey', '')
if jwt.startswith('devin-session-token$'):
    jwt = jwt[20:]

parts = jwt.split('.')
if len(parts) == 3:
    # Decode payload
    payload = base64.urlsafe_b64decode(parts[1] + '=' * (4 - len(parts[1]) % 4))
    claims = json.loads(payload)
    print('JWT Claims:')
    for k, v in claims.items():
        if k in ('exp', 'iat', 'nbf'):
            dt = datetime.fromtimestamp(v)
            print(f'  {k}: {v} ({dt})')
        else:
            print(f'  {k}: {v}')
else:
    print(f'Not a valid JWT: {jwt[:50]}...')

conn.close()

#!/usr/bin/env python3
import json, sqlite3, base64
from pathlib import Path

db = Path.home() / 'AppData' / 'Roaming' / 'Windsurf' / 'User' / 'globalStorage' / 'state.vscdb'
conn = sqlite3.connect(str(db))
c = conn.cursor()

keys_to_check = [
    'windsurf_auth-<your-username>',
    'windsurfAuthStatus',
    'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}',
    'codeium.windsurf-windsurf_auth',
]

for key in keys_to_check:
    c.execute('SELECT value FROM ItemTable WHERE key = ?', (key,))
    row = c.fetchone()
    if row:
        print(f'=== {key} ===')
        val = row[0]
        # Try to decode as JSON
        try:
            data = json.loads(val)
            if isinstance(data, dict):
                for k, v in data.items():
                    sv = str(v)
                    if len(sv) > 80:
                        sv = sv[:80] + '...'
                    print(f'  {k}: {sv}')
            elif isinstance(data, list):
                print(f'  list with {len(data)} items')
                for i, item in enumerate(data[:3]):
                    if isinstance(item, dict):
                        for k, v in item.items():
                            sv = str(v)
                            if len(sv) > 80:
                                sv = sv[:80] + '...'
                            print(f'    [{i}] {k}: {sv}')
                    else:
                        print(f'    [{i}] {str(item)[:80]}')
            else:
                print(f'  {str(data)[:200]}')
        except json.JSONDecodeError:
            # Try base64
            try:
                decoded = base64.b64decode(val)
                print(f'  base64 decoded ({len(decoded)} bytes): {decoded[:100]}')
            except:
                print(f'  raw ({len(val)} chars): {val[:200]}')
    else:
        print(f'=== {key} === NOT FOUND')
    print()

conn.close()

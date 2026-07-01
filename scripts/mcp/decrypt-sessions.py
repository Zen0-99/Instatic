#!/usr/bin/env python3
"""Decrypt VS Code secret storage using Windows DPAPI.
Electron safeStorage on Windows uses DPAPI with the 'v10' prefix."""
import ctypes, ctypes.wintypes, json, sqlite3, base64
from pathlib import Path

# DPAPI constants
CRYPTPROTECT_UI_FORBIDDEN = 0x01
CRYPTPROTECT_LOCAL_MACHINE = 0x04

class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", ctypes.wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]

def dpapi_decrypt(data):
    """Decrypt data using Windows DPAPI."""
    crypt32 = ctypes.windll.crypt32
    
    blob_in = DATA_BLOB(len(data), ctypes.cast(ctypes.c_char_p(data), ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()
    
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,  # description
        None,  # optional entropy
        None,  # reserved
        None,  # prompt
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(blob_out)
    )
    
    if not ok:
        err = ctypes.get_last_error()
        return None
    
    # Extract decrypted data
    decrypted = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    
    # Free the output blob
    ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    
    return decrypted

# Read the encrypted secret from state.vscdb
db = Path.home() / 'AppData' / 'Roaming' / 'Windsurf' / 'User' / 'globalStorage' / 'state.vscdb'
conn = sqlite3.connect(str(db))
c = conn.cursor()

secret_key = 'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}'
c.execute('SELECT value FROM ItemTable WHERE key = ?', (secret_key,))
row = c.fetchone()
if not row:
    print('Secret not found')
    exit(1)

# Parse the value - it might be JSON with Buffer data
val = row[0]
try:
    data = json.loads(val)
    if isinstance(data, dict) and data.get('type') == 'Buffer':
        encrypted = bytes(data['data'])
    else:
        encrypted = base64.b64decode(val)
except:
    encrypted = base64.b64decode(val)

print(f'Encrypted data length: {len(encrypted)}')
print(f'First 10 bytes: {encrypted[:10]}')
print(f'First 3 bytes as string: {encrypted[:3]}')

# Check for v10 prefix (Electron safeStorage format)
if encrypted[:3] == b'v10':
    print('Found v10 prefix (Electron safeStorage)')
    # The rest after v10 is DPAPI-encrypted data
    dpapi_data = encrypted[3:]
    print(f'DPAPI data length: {len(dpapi_data)}')
    
    decrypted = dpapi_decrypt(dpapi_data)
    if decrypted:
        print(f'Decrypted length: {len(decrypted)}')
        try:
            text = decrypted.decode('utf-8')
            print(f'Decrypted text: {text[:500]}')
            # Try to parse as JSON
            sessions = json.loads(text)
            if isinstance(sessions, list):
                print(f'\nFound {len(sessions)} sessions')
                for i, session in enumerate(sessions):
                    if isinstance(session, dict):
                        for k, v in session.items():
                            sv = str(v)
                            if len(sv) > 80:
                                sv = sv[:80] + '...'
                            print(f'  [{i}] {k}: {sv}')
        except Exception as e:
            print(f'Parse error: {e}')
            print(f'Raw decrypted: {decrypted[:200]}')
    else:
        print('DPAPI decryption failed')
        # Try without v10 prefix
        print('Trying full data with DPAPI...')
        decrypted = dpapi_decrypt(encrypted)
        if decrypted:
            print(f'Decrypted (full): {decrypted[:200]}')
        else:
            print('Full DPAPI also failed')
else:
    print('No v10 prefix, trying direct DPAPI...')
    decrypted = dpapi_decrypt(encrypted)
    if decrypted:
        print(f'Decrypted: {decrypted[:200]}')
    else:
        print('DPAPI failed')

conn.close()

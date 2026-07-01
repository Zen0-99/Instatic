#!/usr/bin/env python3
"""
Try to decrypt VS Code secret storage on Windows.
Requires Windows Credential Manager access via ctypes.
"""
import ctypes, json, sqlite3, base64
from pathlib import Path

# VS Code secret storage v10 format
# Header: b'v10' (3 bytes)
# IV: 12 bytes
# Auth tag: 16 bytes (appended to ciphertext in AES-GCM)
# Ciphertext: remaining bytes

def get_dpapi_blob(service_name, account_name):
    """Read a secret from Windows Credential Manager."""
    cred_type = ctypes.c_void_p()
    cred = ctypes.c_void_p()
    
    # CRED_TYPE_GENERIC = 1
    # CRED_ENUMERATE_ALL_CREDENTIALS = 0x1
    advapi32 = ctypes.windll.advapi32
    
    # Try to read the credential
    target = f'VS Code Secret Storage'
    
    class CREDENTIAL(ctypes.Structure):
        _fields_ = [
            ("Flags", ctypes.c_ulong),
            ("Type", ctypes.c_ulong),
            ("TargetName", ctypes.c_wchar_p),
            ("Comment", ctypes.c_wchar_p),
            ("LastWritten", ctypes.c_ulonglong),
            ("CredentialBlobSize", ctypes.c_ulong),
            ("CredentialBlob", ctypes.c_void_p),
            ("Persist", ctypes.c_ulong),
            ("AttributeCount", ctypes.c_ulong),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", ctypes.c_wchar_p),
            ("UserName", ctypes.c_wchar_p),
        ]
    
    pcred = ctypes.POINTER(CREDENTIAL)()
    ok = advapi32.CredReadW(target, 1, 0, ctypes.byref(pcred))
    if not ok:
        err = ctypes.get_last_error()
        print(f'CredReadW failed with error {err}')
        return None
    
    cred = pcred.contents
    blob_size = cred.CredentialBlobSize
    blob_ptr = ctypes.cast(cred.CredentialBlob, ctypes.POINTER(ctypes.c_ubyte))
    blob = bytes(blob_ptr[i] for i in range(blob_size))
    
    advapi32.CredFree(pcred)
    return blob

def main():
    # Get the encryption key from Windows Credential Manager
    key_blob = get_dpapi_blob(None, None)
    if not key_blob:
        print('Could not retrieve VS Code Secret Storage key')
        return
    
    print(f'Got key blob: {len(key_blob)} bytes')
    print(f'First 20 bytes: {key_blob[:20].hex()}')
    
    # Read the encrypted secret from state.vscdb
    db = Path.home() / 'AppData' / 'Roaming' / 'Windsurf' / 'User' / 'globalStorage' / 'state.vscdb'
    conn = sqlite3.connect(str(db))
    c = conn.cursor()
    secret_key = 'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}'
    c.execute('SELECT value FROM ItemTable WHERE key = ?', (secret_key,))
    row = c.fetchone()
    if not row:
        print('Secret not found in state.vscdb')
        return
    
    # The value might be stored as a JSON Buffer or raw bytes
    try:
        val = json.loads(row[0])
        if isinstance(val, dict) and 'type' in val and val['type'] == 'Buffer':
            encrypted = bytes(val['data'])
        else:
            encrypted = base64.b64decode(row[0])
    except:
        encrypted = base64.b64decode(row[0])
    
    print(f'Encrypted secret: {len(encrypted)} bytes')
    print(f'Header: {encrypted[:3]}')
    
    if encrypted[:3] != b'v10':
        print('Not a v10 secret')
        return
    
    # v10 format: header(3) + iv(12) + ciphertext_and_tag(rest)
    iv = encrypted[3:15]
    ciphertext = encrypted[15:]
    
    print(f'IV: {iv.hex()}')
    print(f'Ciphertext length: {len(ciphertext)}')
    
    # Decrypt using AES-GCM
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    
    # The key from CredRead might be a 32-byte AES key
    if len(key_blob) == 32:
        key = key_blob
    else:
        # Try to derive the key - the blob might be a JSON-encoded key
        try:
            key_data = json.loads(key_blob.decode('utf-8'))
            if isinstance(key_data, dict) and 'key' in key_data:
                key = base64.b64decode(key_data['key'])
            else:
                print(f'Unknown key format: {key_blob[:50]}')
                return
        except:
            print(f'Unknown key format: {key_blob[:50]}')
            return
    
    aesgcm = AESGCM(key)
    try:
        plaintext = aesgcm.decrypt(iv, ciphertext, None)
        print('Decrypted successfully!')
        print(plaintext[:200])
    except Exception as e:
        print(f'Decryption failed: {e}')

if __name__ == '__main__':
    main()

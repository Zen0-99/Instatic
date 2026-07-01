#!/usr/bin/env python3
"""List all credentials in Windows Credential Manager."""
import ctypes

advapi32 = ctypes.windll.advapi32

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

PCREDENTIAL = ctypes.POINTER(CREDENTIAL)
PPCREDENTIAL = ctypes.POINTER(PCREDENTIAL)

# CRED_ENUMERATE_ALL_CREDENTIALS = 0x1
# CRED_TYPE_GENERIC = 1

count = ctypes.c_ulong()
creds = ctypes.POINTER(PCREDENTIAL)()

ok = advapi32.CredEnumerateW(None, 0x1, ctypes.byref(count), ctypes.byref(creds))
if not ok:
    err = ctypes.get_last_error()
    print(f'CredEnumerateW failed: {err}')
    exit(1)

print(f'Total credentials: {count.value}')
for i in range(count.value):
    cred = creds[i].contents
    target = cred.TargetName
    blob_size = cred.CredentialBlobSize
    blob_ptr = ctypes.cast(cred.CredentialBlob, ctypes.POINTER(ctypes.c_ubyte))
    blob = bytes(blob_ptr[j] for j in range(blob_size))
    print(f'\nTarget: {target}')
    print(f'  Type: {cred.Type}')
    print(f'  UserName: {cred.UserName}')
    print(f'  Blob size: {blob_size}')
    print(f'  Blob hex: {blob[:50].hex()}')

advapi32.CredFree(creds)

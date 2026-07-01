#!/usr/bin/env python3
"""Test GetStatus RPC to see if the API key is accepted."""
import urllib.request

import os

PORT = int(os.environ.get('WINDSURF_PORT', '0'))
CSRF = os.environ.get('WINDSURF_CSRF_TOKEN', '')
if not PORT or not CSRF:
    print('Set WINDSURF_PORT and WINDSURF_CSRF_TOKEN env vars first')
    import sys; sys.exit(1)

def sf(n, s):
    b = s.encode('utf-8')
    tag = (n << 3) | 2
    t = b''
    v = len(b)
    while v > 0x7f:
        t += bytes([(v & 0x7f) | 0x80])
        v >>= 7
    t += bytes([v])
    return bytes([tag & 0x7f | (0x80 if tag > 0x7f else 0)]) + t + b

def vf(n, v):
    tag = (n << 3) | 0
    return bytes([tag]) + bytes([v])

# Build metadata with FULL apiKey (with prefix)
meta_full = (sf(1, 'windsurf') + sf(2, '1.9600.41') + sf(4, 'en-US') + 
             sf(5, 'Windows') + sf(7, '1.9600.41') + sf(12, 'windsurf') + 
             sf(17, '') + sf(28, 'VSCode') + vf(9, 1))

# Add apiKey with prefix
api_key_full = os.environ.get('WINDSURF_API_KEY', '')
if not api_key_full:
    print('Set WINDSURF_API_KEY env var (full key with devin-session-token$ prefix)')
    import sys; sys.exit(1)
meta_full += sf(3, api_key_full)
meta_full += sf(10, os.environ.get('WINDSURF_INSTALLATION_ID', '00000000-0000-0000-0000-000000000000'))

# Also try stripped key
meta_stripped = (sf(1, 'windsurf') + sf(2, '1.9600.41') + sf(4, 'en-US') + 
                 sf(5, 'Windows') + sf(7, '1.9600.41') + sf(12, 'windsurf') + 
                 sf(17, '') + sf(28, 'VSCode') + vf(9, 1))
api_key_stripped = api_key_full[20:]  # strip prefix
meta_stripped += sf(3, api_key_stripped)
meta_stripped += sf(10, os.environ.get('WINDSURF_INSTALLATION_ID', '00000000-0000-0000-0000-000000000000'))

def rpc(method, body):
    url = f"http://127.0.0.1:{PORT}/exa.language_server_pb.LanguageServerService/{method}"
    req = urllib.request.Request(url, data=body, method='POST',
                                  headers={'Content-Type': 'application/proto',
                                           'Connect-Protocol-Version': '1',
                                           'x-codeium-csrf-token': CSRF})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

# Test with full key
print('=== Testing with FULL apiKey (with prefix) ===')
status, resp = rpc("GetStatus", sf(1, meta_full))
print(f'Status: {status}, Response length: {len(resp)}')
if resp:
    import re
    strings = re.findall(rb'[\x20-\x7e]{3,}', resp)
    for s in strings[:10]:
        print(f'  {s.decode("ascii")}')

# Test with stripped key
print('\n=== Testing with STRIPPED apiKey (no prefix) ===')
status, resp = rpc("GetStatus", sf(1, meta_stripped))
print(f'Status: {status}, Response length: {len(resp)}')
if resp:
    strings = re.findall(rb'[\x20-\x7e]{3,}', resp)
    for s in strings[:10]:
        print(f'  {s.decode("ascii")}')

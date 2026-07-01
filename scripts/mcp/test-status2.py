#!/usr/bin/env python3
"""Test GetStatus RPC to see if the API key is accepted."""
import urllib.request, struct

import os

PORT = int(os.environ.get('WINDSURF_PORT', '0'))
CSRF = os.environ.get('WINDSURF_CSRF_TOKEN', '')
if not PORT or not CSRF:
    print('Set WINDSURF_PORT and WINDSURF_CSRF_TOKEN env vars first')
    import sys; sys.exit(1)

def encode_varint(value):
    bytes_out = []
    while value > 0x7f:
        bytes_out.append((value & 0x7f) | 0x80)
        value >>= 7
    bytes_out.append(value & 0x7f)
    return bytes(bytes_out)

def encode_string(field_num, s):
    tag = (field_num << 3) | 2
    b = s.encode('utf-8')
    return encode_varint(tag) + encode_varint(len(b)) + b

def encode_varint_field(field_num, value):
    tag = (field_num << 3) | 0
    return encode_varint(tag) + encode_varint(value)

def encode_bytes(field_num, b):
    tag = (field_num << 3) | 2
    return encode_varint(tag) + encode_varint(len(b)) + b

# Build metadata
api_key = os.environ.get('WINDSURF_API_KEY', '')
if not api_key:
    print('Set WINDSURF_API_KEY env var (full key with devin-session-token$ prefix)')
    import sys; sys.exit(1)

# Metadata fields
meta = (encode_string(1, 'windsurf') +      # ide_name
        encode_string(2, '1.9600.41') +     # extension_version
        encode_string(4, 'en-US') +           # locale
        encode_string(5, 'Windows') +         # os
        encode_string(7, '1.9600.41') +       # ide_version
        encode_string(12, 'windsurf') +       # extension_name
        encode_string(17, '') +              # extension_path
        encode_string(28, 'VSCode') +         # ide_type
        encode_varint_field(9, 1))           # request_id

# Add apiKey with prefix
meta += encode_string(3, api_key)
meta += encode_string(10, os.environ.get('WINDSURF_INSTALLATION_ID', '00000000-0000-0000-0000-000000000000'))

# GetStatusRequest: field 1 = metadata
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
print('=== Testing GetStatus ===')
body = encode_bytes(1, meta)
status, resp = rpc("GetStatus", body)
print(f'Status: {status}, Response length: {len(resp)}')
if resp:
    import re
    strings = re.findall(rb'[\x20-\x7e]{3,}', resp)
    for s in strings[:10]:
        print(f'  {s.decode("ascii")}')

#!/usr/bin/env python3
"""Debug script: dump the raw protobuf structure of GetCascadeTrajectorySteps response."""
import os, struct, sys, time, urllib.request

PORT = int(os.environ.get('WINDSURF_PORT', '0'))
CSRF = os.environ.get('WINDSURF_CSRF_TOKEN', '')
if not PORT or not CSRF:
    print('Set WINDSURF_PORT and WINDSURF_CSRF_TOKEN env vars first')
    sys.exit(1)
CASCADE_ID = sys.argv[1] if len(sys.argv) > 1 else None

if not CASCADE_ID:
    print("Usage: python debug-steps.py <cascade_id>")
    sys.exit(1)

def decode_varint(data, offset):
    result = 0
    shift = 0
    start = offset
    while offset < len(data):
        byte = data[offset]
        result |= (byte & 0x7f) << shift
        shift += 7
        offset += 1
        if (byte & 0x80) == 0:
            break
    return result, offset - start

def parse_fields(data, depth=0):
    """Recursively parse protobuf and print field structure."""
    offset = 0
    indent = "  " * depth
    while offset < len(data):
        tag, tag_bytes = decode_varint(data, offset)
        offset += tag_bytes
        field_num = tag >> 3
        wire_type = tag & 0x7

        if wire_type == 2:  # length-delimited
            length, len_bytes = decode_varint(data, offset)
            offset += len_bytes
            field_data = data[offset:offset + length]
            offset += length

            # Try to interpret as UTF-8 string
            try:
                text = field_data.decode('utf-8')
                # Only print if it looks like readable text
                printable = sum(1 for c in text if c.isprintable() or c in '\n\r\t')
                if len(text) > 3 and printable / len(text) > 0.8:
                    preview = text.replace('\n', '\\n')[:100]
                    print(f"{indent}field {field_num}: \"{preview}\"")
                else:
                    print(f"{indent}field {field_num}: <bytes len={length}>")
                    # Recurse into nested message
                    if depth < 3 and length > 2:
                        parse_fields(field_data, depth + 1)
            except:
                print(f"{indent}field {field_num}: <bytes len={length}>")
                if depth < 3 and length > 2:
                    parse_fields(field_data, depth + 1)

        elif wire_type == 0:  # varint
            value, val_bytes = decode_varint(data, offset)
            offset += val_bytes
            print(f"{indent}field {field_num}: {value}")
        elif wire_type == 5:  # 32-bit
            offset += 4
            print(f"{indent}field {field_num}: <32-bit>")
        elif wire_type == 1:  # 64-bit
            offset += 8
            print(f"{indent}field {field_num}: <64-bit>")
        else:
            break

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

# Build metadata
meta = (sf(1, 'windsurf') +      # ide_name
        sf(2, '1.9600.41') +     # extension_version
        sf(7, '1.9600.41') +     # ide_version
        sf(12, 'windsurf'))      # extension_name

# Poll for steps
body = sf(1, CASCADE_ID) + vf(2, 0)
print(f"Polling GetCascadeTrajectorySteps for {CASCADE_ID}...")
status, resp = rpc("GetCascadeTrajectorySteps", body)
print(f"Status: {status}, Response: {len(resp)} bytes")

if status == 200 and resp:
    print("\nParsed fields:")
    parse_fields(resp)
else:
    print(f"Error: {resp[:200]}")

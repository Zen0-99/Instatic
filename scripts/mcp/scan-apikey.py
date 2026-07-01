#!/usr/bin/env python3
"""Scan Windsurf processes for devin-session-token$ prefix to find the live API key."""
import ctypes, ctypes.wintypes, struct, subprocess, re

kernel32 = ctypes.windll.kernel32
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", ctypes.c_ulong),
        ("RegionSize", ctypes.c_size_t),
        ("State", ctypes.c_ulong),
        ("Protect", ctypes.c_ulong),
        ("Type", ctypes.c_ulong),
    ]

MEM_COMMIT = 0x1000
READABLE_PROTECTS = {0x02, 0x04, 0x08, 0x20, 0x40}

def scan_process_for_pattern(pid, pattern_bytes, context_before=0, context_after=300, max_results=30):
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return []
    
    results = []
    address = 0
    mbi = MEMORY_BASIC_INFORMATION()
    
    while address < 0x7fffffffffff:
        if kernel32.VirtualQueryEx(h, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
            break
        
        base = mbi.BaseAddress or 0
        region_size = mbi.RegionSize or 0
        if region_size == 0:
            break
        
        if mbi.State == MEM_COMMIT and mbi.Protect in READABLE_PROTECTS:
            read_size = min(region_size, 0x1000000)
            buf = (ctypes.c_char * read_size)()
            bytesRead = ctypes.c_size_t(0)
            ok = kernel32.ReadProcessMemory(h, ctypes.c_void_p(base), buf, read_size, ctypes.byref(bytesRead))
            if ok and bytesRead.value > 0:
                data = buf.raw[:bytesRead.value]
                idx = 0
                while idx < len(data):
                    pos = data.find(pattern_bytes, idx)
                    if pos == -1:
                        break
                    start = max(0, pos - context_before)
                    end = min(len(data), pos + len(pattern_bytes) + context_after)
                    chunk = data[start:end]
                    results.append(chunk)
                    if len(results) >= max_results:
                        kernel32.CloseHandle(h)
                        return results
                    idx = pos + len(pattern_bytes)
        
        next_addr = base + region_size
        if next_addr <= address:
            break
        address = next_addr
    
    kernel32.CloseHandle(h)
    return results

# Find all Windsurf.exe PIDs
result = subprocess.run(['wmic', 'process', 'where', "name='Windsurf.exe'", 'get', 'ProcessId,CommandLine'], capture_output=True, text=True)
pids = []
for line in result.stdout.split('\n'):
    line = line.strip()
    # Skip lines that are just numbers (header already processed)
    parts = line.split()
    for p in parts:
        if p.isdigit():
            pids.append(int(p))

# Also get the main window PIDs
result2 = subprocess.run(['wmic', 'process', 'where', "name='Windsurf.exe' and CommandLine like '%type=renderer%'", 'get', 'ProcessId'], capture_output=True, text=True)

# Deduplicate
pids = list(set(pids))
print(f'Found {len(pids)} Windsurf.exe processes: {pids}')

pattern = b'devin-session-token$'
all_tokens = set()

for pid in pids:
    try:
        chunks = scan_process_for_pattern(pid, pattern, context_before=0, context_after=200)
        if chunks:
            for chunk in chunks:
                # Extract the token after the prefix
                text = chunk.decode('ascii', errors='replace')
                # Find JWT-like token
                jwt_match = re.search(r'devin-session-token\$([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)', text)
                if jwt_match:
                    token = jwt_match.group(1)
                    if len(token) > 50:
                        all_tokens.add(token)
                        print(f'  PID {pid}: Found token (len={len(token)})')
    except Exception as e:
        pass

print(f'\nTotal unique tokens found: {len(all_tokens)}')
for token in all_tokens:
    print(f'\nToken (len={len(token)}):')
    print(f'  {token[:60]}...{token[-20:]}')
    
    # Decode JWT payload
    parts = token.split('.')
    if len(parts) == 3:
        import base64, json
        payload = base64.urlsafe_b64decode(parts[1] + '=' * (4 - len(parts[1]) % 4))
        claims = json.loads(payload)
        print(f'  Claims: {json.dumps(claims)}')

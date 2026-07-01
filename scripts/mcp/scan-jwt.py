#!/usr/bin/env python3
"""Scan extension host process memory for JWT tokens (starting with eyJ)."""
import ctypes, ctypes.wintypes, struct, subprocess, re, sys

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
PAGE_READWRITE = 0x04
PAGE_READONLY = 0x02
PAGE_EXECUTE_READ = 0x20
PAGE_EXECUTE_READWRITE = 0x40
PAGE_WRITECOPY = 0x08

def scan_process(pid, pattern_bytes, max_results=20):
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        print(f'Cannot open process {pid}')
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
        
        if mbi.State == MEM_COMMIT and mbi.Protect in (PAGE_READWRITE, PAGE_READONLY, PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE, PAGE_WRITECOPY):
            region_size = min(region_size, 0x1000000)  # Cap at 16MB per region
            buf = (ctypes.c_char * region_size)()
            bytesRead = ctypes.c_size_t(0)
            ok = kernel32.ReadProcessMemory(h, ctypes.c_void_p(base), buf, region_size, ctypes.byref(bytesRead))
            if ok and bytesRead.value > 0:
                data = buf.raw[:bytesRead.value]
                idx = 0
                while idx < len(data):
                    pos = data.find(pattern_bytes, idx)
                    if pos == -1:
                        break
                    # Extract surrounding context (up to 300 bytes)
                    start = max(0, pos - 20)
                    end = min(len(data), pos + 300)
                    chunk = data[start:end]
                    # Try to decode as ASCII
                    try:
                        text = chunk.decode('ascii', errors='replace')
                        # Find the end of the JWT (typically ends with alphanumeric)
                        jwt_match = re.search(r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', text)
                        if jwt_match:
                            jwt = jwt_match.group()
                            if len(jwt) > 50:  # Real JWTs are longer
                                results.append(jwt)
                                if len(results) >= max_results:
                                    kernel32.CloseHandle(h)
                                    return results
                    except:
                        pass
                    idx = pos + len(pattern_bytes)
        
        next_addr = base + region_size
        if next_addr <= address:
            break
        address = next_addr
    
    kernel32.CloseHandle(h)
    return results

# Find extension host PID
result = subprocess.run(['wmic', 'process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine'], capture_output=True, text=True)
for line in result.stdout.split('\n'):
    if 'extensionHost' in line or 'extension_host' in line or 'exthost' in line:
        parts = line.strip().split()
        if parts:
            pid_str = parts[-1]
            if pid_str.isdigit():
                pid = int(pid_str)
                print(f'Extension host PID: {pid}')
                print('Scanning for JWT tokens...')
                tokens = scan_process(pid, b'eyJ')
                if tokens:
                    print(f'\nFound {len(tokens)} JWT tokens:')
                    seen = set()
                    for t in tokens:
                        if t not in seen:
                            seen.add(t)
                            print(f'  Length: {len(t)}')
                            print(f'  Token: {t[:60]}...{t[-20:]}')
                else:
                    print('No JWT tokens found')
                break

# Also scan the main Windsurf window process
result2 = subprocess.run(['wmic', 'process', 'where', "name='Windsurf.exe'", 'get', 'ProcessId'], capture_output=True, text=True)
for line in result2.stdout.split('\n'):
    line = line.strip()
    if line.isdigit():
        pid = int(line)
        print(f'\nWindsurf.exe PID: {pid}')
        print('Scanning for JWT tokens...')
        tokens = scan_process(pid, b'eyJ')
        if tokens:
            print(f'Found {len(tokens)} JWT tokens:')
            seen = set()
            for t in tokens:
                if t not in seen:
                    seen.add(t)
                    print(f'  Length: {len(t)}')
                    print(f'  Token: {t[:60]}...{t[-20:]}')
        else:
            print('No JWT tokens found')
        break

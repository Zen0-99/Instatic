#!/usr/bin/env python3
"""Dump ALL environment variables from the language server process."""
import ctypes, ctypes.wintypes, sys, struct, re

kernel32 = ctypes.windll.kernel32

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

class PROCESS_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Reserved1", ctypes.c_void_p),
        ("PebBaseAddress", ctypes.c_void_p),
        ("Reserved2", ctypes.c_void_p * 2),
        ("UniqueProcessId", ctypes.c_ulong),
        ("Reserved3", ctypes.c_void_p),
    ]

def read_process_memory(pid, address, size):
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return None
    buf = (ctypes.c_char * size)()
    bytesRead = ctypes.c_size_t(0)
    ok = kernel32.ReadProcessMemory(h, ctypes.c_void_p(address), buf, size, ctypes.byref(bytesRead))
    kernel32.CloseHandle(h)
    if not ok:
        return None
    return buf.raw[:bytesRead.value]

def get_env_block(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return None
    
    pbi = PROCESS_BASIC_INFORMATION()
    status = ctypes.windll.ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), None)
    if status:
        kernel32.CloseHandle(h)
        return None
    
    peb_addr = pbi.PebBaseAddress
    # Read PEB to get ProcessParameters pointer
    peb_data = read_process_memory(pid, peb_addr, 0x100)
    if not peb_data:
        kernel32.CloseHandle(h)
        return None
    
    # ProcessParameters is at offset 0x20 in PEB (64-bit)
    pp_addr = struct.unpack('<Q', peb_data[0x20:0x28])[0]
    
    # Read ProcessParameters
    pp_data = read_process_memory(pid, pp_addr, 0x200)
    if not pp_data:
        kernel32.CloseHandle(h)
        return None
    
    # Environment is at offset 0x80 in ProcessParameters (64-bit)
    env_addr = struct.unpack('<Q', pp_data[0x80:0x88])[0]
    env_size = struct.unpack('<Q', pp_data[0x90:0x98])[0]
    
    kernel32.CloseHandle(h)
    
    # Read environment block
    env_data = read_process_memory(pid, env_addr, min(env_size, 0x10000))
    if not env_data:
        return None
    
    return env_data

# Find language server PID
import subprocess
result = subprocess.run(['wmic', 'process', 'where', "name='language_server_windows_x64.exe'", 'get', 'ProcessId'], capture_output=True, text=True)
lines = [l.strip() for l in result.stdout.strip().split('\n') if l.strip().isdigit()]
if not lines:
    print('Language server not found')
    sys.exit(1)

pid = int(lines[0])
print(f'Language server PID: {pid}')

env_data = get_env_block(pid)
if not env_data:
    print('Failed to read environment block')
    sys.exit(1)

# Parse environment block (UTF-16LE, null-separated entries, double-null terminated)
try:
    env_str = env_data.decode('utf-16-le', errors='replace')
except:
    env_str = env_data.decode('utf-8', errors='replace')

entries = env_str.split('\x00')
for entry in entries:
    if not entry:
        continue
    # Check for API key, token, auth related
    if any(x in entry.upper() for x in ['KEY', 'TOKEN', 'AUTH', 'SESSION', 'CSRF', 'API', 'SECRET', 'WINDSURF', 'CODEIUM', 'DEVIN']):
        # Mask sensitive values
        if '=' in entry:
            k, v = entry.split('=', 1)
            if len(v) > 20:
                v = v[:20] + '...'
            print(f'  {k}={v}')
        else:
            print(f'  {entry}')

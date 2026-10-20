import fcntl
import json
import os
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

master, slave = os.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
process = subprocess.Popen([
    str(Path('dist/mvm').resolve()), '--profile', 'AdministratorAccess-242201303782',
    '--region', 'ap-northeast-1', 'ssh', sys.argv[1],
], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b''

def until(expected):
    global output
    deadline = time.monotonic() + 20
    while expected not in output:
        if time.monotonic() > deadline:
            raise RuntimeError('PTY check timed out: ' + repr(output[-1000:]))
        if select.select([master], [], [], .2)[0]:
            output += os.read(master, 65536)

try:
    os.write(master, b"printf '__FIRST__'; stty size\n")
    until(b'__FIRST__24 80\r\n')
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 100, 0, 0))
    os.kill(process.pid, signal.SIGWINCH)
    time.sleep(.3)
    os.write(master, b"printf '__RESIZED__'; stty size\n")
    until(b'__RESIZED__35 100\r\n')
    os.write(master, b'sleep 60\n')
    time.sleep(.3)
    os.write(master, b'\x03')
    time.sleep(.3)
    os.write(master, b"printf '__AFTER_INTERRUPT__\\n'\nexit\n")
    until(b'\r\n__AFTER_INTERRUPT__\r\n')
    assert process.wait(timeout=10) == 0
    result = {'vmId': sys.argv[1], 'initialSize': [24, 80], 'resized': [35, 100], 'ctrlC': True, 'exitCode': 0}
    Path(__file__).with_name('evidence').joinpath('pty-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    os.close(master)

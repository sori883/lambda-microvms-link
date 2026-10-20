import { readFile, readdir, stat } from 'node:fs/promises';

const processes = [];
for (const pid of await readdir('/proc')) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split(/[\0\s]+/);
    if (!/Xtigervnc|xfce4-session|\/chromium$/.test(command[0] ?? '')) continue;
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    processes.push({
      pid: Number(pid), executable: command[0],
      role: command.find(value => value.startsWith('--type=')) ?? 'main',
      sandboxDisabled: command.includes('--no-sandbox'),
      uid: status.match(/^Uid:\s*(.*)$/m)?.[1],
      noNewPrivileges: status.match(/^NoNewPrivs:\s*(.*)$/m)?.[1],
      seccomp: status.match(/^Seccomp:\s*(.*)$/m)?.[1],
      uidMap: (await readFile(`/proc/${pid}/uid_map`, 'utf8')).trim(),
    });
  } catch {}
}
const paths = {};
for (const path of ['/tmp/mvm-desktop-1000', '/tmp/mvm-desktop-1000/vnc.sock', '/tmp/mvm-desktop-1000/control.sock']) {
  const info = await stat(path);
  paths[path] = { uid: info.uid, mode: (info.mode & 0o777).toString(8), socket: info.isSocket() };
}
const ports = [];
for (const table of ['tcp', 'tcp6']) {
  for (const line of (await readFile(`/proc/net/${table}`, 'utf8')).trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] === '0A') ports.push(parseInt(fields[1].split(':')[1], 16));
  }
}
console.log(JSON.stringify({ processes, paths, tcpListenPorts: ports }, null, 2));

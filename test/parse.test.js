import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupe,
  familyOf,
  isLoopback,
  listeningOnly,
  parseLsof,
  parseNetstatLinux,
  parseNetstatWindows,
  parseSs,
  parseTasklistCsv,
  splitEndpoint,
} from '../src/parse.js';

const WIN = `
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1932
  TCP    127.0.0.1:7891         0.0.0.0:0              LISTENING       5768
  TCP    [::]:445               [::]:0                 LISTENING       4
  TCP    192.168.1.5:52344      93.184.216.34:443      ESTABLISHED     8123
  UDP    0.0.0.0:5353           *:*                                    6900
  UDP    [::]:5353              *:*                                    6900
`;

test('splitEndpoint understands the shapes each OS prints', () => {
  assert.deepEqual(splitEndpoint('0.0.0.0:8080'), { address: '0.0.0.0', port: 8080 });
  assert.deepEqual(splitEndpoint('[::]:8080'), { address: '::', port: 8080 });
  assert.deepEqual(splitEndpoint('[::1]:3000'), { address: '::1', port: 3000 });
  assert.deepEqual(splitEndpoint('*:3000'), { address: '*', port: 3000 });
  assert.deepEqual(splitEndpoint(':::22'), { address: '::', port: 22 });
  assert.equal(splitEndpoint(''), null);
  assert.equal(splitEndpoint('nonsense'), null);
});

test('family and loopback classification', () => {
  assert.equal(familyOf('127.0.0.1'), 'ipv4');
  assert.equal(familyOf('::1'), 'ipv6');
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('0.0.0.0'), false);
});

test('parses Windows netstat rows regardless of the header language', () => {
  const entries = parseNetstatWindows(WIN);
  assert.equal(entries.length, 6);

  const first = entries[0];
  assert.equal(first.port, 135);
  assert.equal(first.address, '0.0.0.0');
  assert.equal(first.pid, 1932);
  assert.equal(first.proto, 'tcp');
  assert.equal(first.state, 'LISTEN');

  const v6 = entries.find((e) => e.port === 445);
  assert.equal(v6.family, 'ipv6');
  assert.equal(v6.address, '::');

  const established = entries.find((e) => e.port === 52344);
  assert.equal(established.state, 'ESTABLISHED');
  assert.equal(established.pid, 8123);

  const udp = entries.filter((e) => e.proto === 'udp');
  assert.equal(udp.length, 2);
  assert.equal(udp[0].pid, 6900);
  assert.equal(udp[0].state, '');
});

test('windows netstat without a pid column is skipped, not crashed on', () => {
  const entries = parseNetstatWindows('TCP 0.0.0.0:80 0.0.0.0:0 LISTENING\nTCP\nUDP 0.0.0.0:53 *:*');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].port, 80);
  assert.equal(entries[0].pid, null);
});

test('tasklist csv becomes a pid → name map', () => {
  const names = parseTasklistCsv('"node.exe","8123","Console","1","48,000 K"\r\n"svchost.exe","1932","Services","0","7,756 K"\r\n');
  assert.equal(names.get(8123), 'node.exe');
  assert.equal(names.get(1932), 'svchost.exe');
  assert.equal(names.size, 2);
});

const SS = `
Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*     users:(("nginx",pid=812,fd=6))
tcp   LISTEN 0      4096            [::]:22           [::]:*     users:(("sshd",pid=901,fd=4))
udp   UNCONN 0      0            0.0.0.0:68        0.0.0.0:*     users:(("dhclient",pid=611,fd=7))
tcp   LISTEN 0      511        127.0.0.1:3000    0.0.0.0:*
`;

test('parses ss output with and without a process column', () => {
  const entries = parseSs(SS);
  assert.equal(entries.length, 4);
  const nginx = entries[0];
  assert.equal(nginx.port, 80);
  assert.equal(nginx.process, 'nginx');
  assert.equal(nginx.pid, 812);
  assert.equal(nginx.state, 'LISTEN');

  const sshd = entries[1];
  assert.equal(sshd.family, 'ipv6');
  assert.equal(sshd.address, '::');

  const local = entries[3];
  assert.equal(local.port, 3000);
  assert.equal(local.pid, null);
  assert.equal(local.process, null);
});

test('parses the classic linux netstat table as a fallback', () => {
  const text = `
Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd
tcp6       0      0 :::443                  :::*                    LISTEN      -
udp        0      0 0.0.0.0:123             0.0.0.0:*                           611/chronyd
`;
  const entries = parseNetstatLinux(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].port, 22);
  assert.equal(entries[0].pid, 812);
  assert.equal(entries[0].process, 'sshd');
  assert.equal(entries[1].proto, 'tcp');
  assert.equal(entries[1].family, 'ipv6');
  assert.equal(entries[1].pid, null);
  assert.equal(entries[2].proto, 'udp');
});

test('parses lsof listen lines', () => {
  const text = `COMMAND   PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    8123 alex   23u  IPv4 0x1234567890abcdef      0t0  TCP *:8080 (LISTEN)
node    8123 alex   24u  IPv6 0x1234567890abcdea      0t0  TCP [::1]:8080 (LISTEN)
postgres  900 alex    7u  IPv4 0x1234567890abcdeb      0t0  TCP 127.0.0.1:5432 (LISTEN)
`;
  const entries = parseLsof(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].port, 8080);
  assert.equal(entries[0].pid, 8123);
  assert.equal(entries[0].process, 'node');
  assert.equal(entries[0].address, '*');
  assert.equal(entries[1].family, 'ipv6');
  assert.equal(entries[2].address, '127.0.0.1');
});

test('listeningOnly keeps UDP and drops established connections', () => {
  const entries = parseNetstatWindows(WIN);
  const open = listeningOnly(entries);
  assert.equal(open.length, 5);
  assert.ok(open.every((e) => e.state !== 'ESTABLISHED'));
});

test('dedupe drops exact duplicates only', () => {
  const entries = parseNetstatWindows(WIN);
  const twice = entries.concat(entries);
  assert.equal(dedupe(twice).length, entries.length);
});

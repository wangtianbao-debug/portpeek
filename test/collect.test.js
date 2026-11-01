import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, findFreePort, isTaken, ownersOf, sortEntries } from '../src/collect.js';

const WIN_NETSTAT = `
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1932
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       8123
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321
  UDP    0.0.0.0:5353           *:*                                    6900
`;

const WIN_TASKLIST = `"svchost.exe","1932","Services","0","7,756 K"
"node.exe","8123","Console","1","48,000 K"
"other.exe","4321","Console","1","10,000 K"
`;

const SS_OUT = `
tcp   LISTEN 0      511          0.0.0.0:22        0.0.0.0:*     users:(("sshd",pid=901,fd=4))
tcp   LISTEN 0      511        127.0.0.1:4000    0.0.0.0:*     users:(("node",pid=77,fd=20))
`;

function runner(table) {
  const calls = [];
  const run = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    const hit = table[key] ?? table[cmd];
    if (hit === undefined) {
      const err = new Error(`spawn ${cmd} ENOENT`);
      err.code = 'ENOENT';
      throw err;
    }
    return hit;
  };
  run.calls = calls;
  return run;
}

test('windows: netstat rows are joined with tasklist names', () => {
  const run = runner({ 'netstat -ano': WIN_NETSTAT, 'tasklist /fo csv /nh': WIN_TASKLIST });
  const { entries, source, platform } = collect({ platform: 'win32', run });
  assert.equal(platform, 'win32');
  assert.equal(source, 'netstat -ano');
  assert.equal(entries.length, 3, 'UDP is excluded by default');
  assert.equal(entries.find((e) => e.port === 135).process, 'svchost.exe');
  assert.equal(entries.find((e) => e.port === 3000 && e.pid === 8123).process, 'node.exe');
});

test('windows: --all keeps UDP sockets', () => {
  const run = runner({ 'netstat -ano': WIN_NETSTAT, 'tasklist /fo csv /nh': WIN_TASKLIST });
  const { entries } = collect({ platform: 'win32', run, udp: true });
  assert.equal(entries.length, 4);
  assert.ok(entries.some((e) => e.proto === 'udp'));
});

test('windows: a missing tasklist still lists ports', () => {
  const run = runner({ 'netstat -ano': WIN_NETSTAT });
  const { entries } = collect({ platform: 'win32', run });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].process, null);
});

test('linux: prefers ss', () => {
  const run = runner({ ss: SS_OUT, 'ss -lntp': SS_OUT });
  const { entries, source } = collect({ platform: 'linux', run });
  assert.equal(source, 'ss');
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.port === 4000).process, 'node');
});

test('linux: falls back to netstat when ss is absent', () => {
  const netstat = `
tcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN      555/java
`;
  const run = runner({ 'netstat -lntp': netstat });
  const { entries, source } = collect({ platform: 'linux', run });
  assert.equal(source, 'netstat');
  assert.equal(entries[0].port, 8080);
  assert.equal(entries[0].process, 'java');
});

test('linux: both collectors missing is a clear error', () => {
  const run = runner({});
  assert.throws(() => collect({ platform: 'linux', run }), /neither `ss` nor `netstat`/);
});

test('macos: uses lsof and asks for UDP only when wanted', () => {
  const tcp = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node 8123 alex 23u IPv4 0x1 0t0 TCP *:8080 (LISTEN)`;
  const udp = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node 8123 alex 24u IPv4 0x2 0t0 UDP *:9999`;
  const run = runner({ 'lsof -nP -iTCP -sTCP:LISTEN': tcp, 'lsof -nP -iUDP': udp });
  assert.equal(collect({ platform: 'darwin', run }).entries.length, 1);
  assert.equal(collect({ platform: 'darwin', run, udp: true }).entries.length, 2);
});

test('sorting is by port, then protocol, then address', () => {
  const entries = [
    { port: 3000, proto: 'udp', address: '0.0.0.0', pid: 1 },
    { port: 80, proto: 'tcp', address: '0.0.0.0', pid: 2 },
    { port: 3000, proto: 'tcp', address: '::', pid: 3 },
  ];
  assert.deepEqual(
    sortEntries(entries).map((e) => `${e.port}${e.proto}${e.address}`),
    ['80tcp0.0.0.0', '3000tcp::', '3000udp0.0.0.0'],
  );
});

test('ownersOf finds every socket bound to a port', () => {
  const run = runner({ 'netstat -ano': WIN_NETSTAT, 'tasklist /fo csv /nh': WIN_TASKLIST });
  const { entries } = collect({ platform: 'win32', run });
  const owners = ownersOf(entries, 3000);
  assert.equal(owners.length, 2);
  assert.deepEqual(owners.map((o) => o.pid).sort(), [4321, 8123]);
  assert.equal(ownersOf(entries, 9999).length, 0);
});

test('isTaken respects wildcard and loopback binds', () => {
  const entries = [
    { port: 3000, proto: 'tcp', address: '127.0.0.1', pid: 1 },
    { port: 4000, proto: 'tcp', address: '0.0.0.0', pid: 2 },
  ];
  assert.equal(isTaken(entries, 3000), true);
  assert.equal(isTaken(entries, 3000, '127.0.0.1'), true);
  assert.equal(isTaken(entries, 3000, '0.0.0.0'), false, 'loopback bind leaves the wildcard free');
  assert.equal(isTaken(entries, 4000, '10.0.0.5'), true, 'wildcard covers every interface');
  assert.equal(isTaken(entries, 5000), false);
});

test('findFreePort walks upwards and honours the limit', () => {
  const entries = [
    { port: 3000, proto: 'tcp', address: '0.0.0.0', pid: 1 },
    { port: 3001, proto: 'tcp', address: '0.0.0.0', pid: 1 },
  ];
  assert.equal(findFreePort(entries, 3000), 3002);
  assert.equal(findFreePort(entries, 3010), 3010);
  assert.equal(findFreePort(entries, 3000, 1), null);
});

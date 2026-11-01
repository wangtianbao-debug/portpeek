import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCheck, formatJson, formatPlain, formatTable, makeColors } from '../src/format.js';

const plain = makeColors(false);

const SAMPLE = [
  { port: 80, proto: 'tcp', family: 'ipv4', address: '0.0.0.0', pid: 812, process: 'nginx', state: 'LISTEN' },
  { port: 3000, proto: 'tcp', family: 'ipv4', address: '127.0.0.1', pid: 8123, process: 'node.exe', state: 'LISTEN' },
];

test('colours are opt-in', () => {
  assert.equal(makeColors(false).red('x'), 'x');
  assert.match(makeColors(true).red('x'), /\x1b\[31mx\x1b\[0m/);
});

test('table has a header, aligned columns and a count', () => {
  const text = formatTable(SAMPLE, { color: plain });
  const lines = text.trimEnd().split('\n');
  assert.match(lines[0], /^PORT\s+PROTO\s+ADDRESS\s+PID\s+PROCESS$/);
  assert.match(lines[1], /^\s+80\s+tcp\s+0\.0\.0\.0\s+812\s+nginx$/);
  assert.match(lines[2], /^\s*3000\s+tcp\s+127\.0\.0\.1\s+8123\s+node\.exe$/);
  assert.match(text, /2 listening sockets/);
});

test('the port column is right aligned so digits stack', () => {
  const lines = formatTable(SAMPLE, { color: plain }).split('\n');
  const colOf = (line, token) => line.indexOf(token);
  assert.equal(colOf(lines[1], '80'), colOf(lines[2], '3000') + 2);
});

test('an empty table says so instead of printing a header', () => {
  assert.match(formatTable([], { color: plain }), /no listening sockets/);
});

test('plain output is one socket per line', () => {
  const text = formatPlain(SAMPLE);
  assert.equal(text, '80 tcp 0.0.0.0 pid 812 nginx\n3000 tcp 127.0.0.1 pid 8123 node.exe\n');
});

test('json output is stable and complete', () => {
  const parsed = JSON.parse(formatJson(SAMPLE, { source: 'netstat -ano', platform: 'win32' }));
  assert.equal(parsed.source, 'netstat -ano');
  assert.equal(parsed.platform, 'win32');
  assert.equal(parsed.sockets.length, 2);
  assert.deepEqual(parsed.sockets[0], {
    port: 80,
    proto: 'tcp',
    family: 'ipv4',
    address: '0.0.0.0',
    pid: 812,
    process: 'nginx',
    state: 'LISTEN',
  });
});

test('check output names the owner', () => {
  const taken = formatCheck(3000, [SAMPLE[1]], { color: plain });
  assert.match(taken, /^in use\s+port 3000 is held by/);
  assert.match(taken, /tcp 127\.0\.0\.1:3000\s+node\.exe \(pid 8123\)/);

  const free = formatCheck(3001, [], { color: plain });
  assert.match(free, /^free\s+port 3001 is not in use/);
});

test('ipv6 endpoints are bracketed in prose', () => {
  const text = formatCheck(135, [{ ...SAMPLE[0], family: 'ipv6', address: '::', port: 135 }], { color: plain });
  assert.match(text, /tcp \[::\]:135/);
});

test('unknown process names degrade to a readable line', () => {
  const text = formatCheck(80, [{ ...SAMPLE[0], process: null, pid: null }], { color: plain });
  assert.match(text, /unknown process/);
});

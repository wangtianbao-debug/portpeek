import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run } from '../src/cli.js';

function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s), isTTY: false }, error: (s) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

const SAMPLE = [
  { port: 3000, proto: 'tcp', family: 'ipv4', address: '0.0.0.0', pid: 8123, process: 'node.exe', state: 'LISTEN' },
  { port: 8080, proto: 'tcp', family: 'ipv4', address: '127.0.0.1', pid: 900, process: 'java', state: 'LISTEN' },
];

const deps = { collect: () => ({ entries: SAMPLE, source: 'fixture', platform: 'test' }) };

test('parses the port and the flags', () => {
  const { opts } = parseArgs(['3000', '-a', '--json']);
  assert.equal(opts.port, 3000);
  assert.equal(opts.all, true);
  assert.equal(opts.json, true);

  const free = parseArgs(['--free', '4000']).opts;
  assert.equal(free.free, true);
  assert.equal(free.freeStart, 4000);

  assert.equal(parseArgs(['--free']).opts.freeStart, 3000);
});

test('rejects nonsense with exit code 2', () => {
  for (const argv of [['abc'], ['0'], ['70000'], ['3000', '4000'], ['--nope'], ['-p'], ['-p', 'x'], ['--free', '--json', '3000']]) {
    assert.equal(run(argv, capture().io, deps), 2, `argv: ${argv.join(' ')}`);
  }
});

test('help and version are quiet successes', () => {
  const help = capture();
  assert.equal(run(['--help'], help.io, deps), 0);
  assert.match(help.out(), /portpeek — see which process is holding a port/);

  const version = capture();
  assert.equal(run(['-v'], version.io, deps), 0);
  assert.match(version.out().trim(), /^\d+\.\d+\.\d+$/);
});

test('lists sockets as a table by default', () => {
  const c = capture();
  assert.equal(run([], c.io, deps), 0);
  assert.match(c.out(), /PORT\s+PROTO\s+ADDRESS\s+PID\s+PROCESS/);
  assert.match(c.out(), /node\.exe/);
  assert.equal(c.err(), '');
});

test('a busy port exits 1 and explains who holds it', () => {
  const c = capture();
  assert.equal(run(['3000'], c.io, deps), 1);
  assert.match(c.out(), /in use/);
  assert.match(c.out(), /node\.exe \(pid 8123\)/);
});

test('a free port exits 0', () => {
  const c = capture();
  assert.equal(run(['3001'], c.io, deps), 0);
  assert.match(c.out(), /free/);
});

test('--json answers the same question structurally', () => {
  const taken = capture();
  assert.equal(run(['3000', '--json'], taken.io, deps), 1);
  const parsed = JSON.parse(taken.out());
  assert.equal(parsed.port, 3000);
  assert.equal(parsed.taken, true);
  assert.equal(parsed.owners[0].pid, 8123);

  const free = capture();
  assert.equal(run(['3001', '--json'], free.io, deps), 0);
  assert.equal(JSON.parse(free.out()).taken, false);
});

test('--free prints just the number', () => {
  const c = capture();
  assert.equal(run(['--free'], c.io, deps), 0);
  assert.equal(c.out(), '3001\n');
});

test('--pid narrows the list', () => {
  const c = capture();
  assert.equal(run(['-p', '8123'], c.io, deps), 0);
  assert.match(c.out(), /node\.exe/);
  assert.doesNotMatch(c.out(), /java/);
  assert.match(c.out(), /1 listening socket/);
});

test('--plain and -q behave', () => {
  const plain = capture();
  assert.equal(run(['--plain'], plain.io, deps), 0);
  assert.equal(plain.out(), '3000 tcp 0.0.0.0 pid 8123 node.exe\n8080 tcp 127.0.0.1 pid 900 java\n');

  const quiet = capture();
  assert.equal(run(['-q'], quiet.io, deps), 0);
  assert.equal(quiet.out(), '');
});

test('a collector failure exits 3 with the reason', () => {
  const c = capture();
  const failing = { collect: () => { throw new Error('boom'); } };
  assert.equal(run([], c.io, failing), 3);
  assert.match(c.err(), /portpeek: boom/);
});

test('a full port range reports no free port', () => {
  const c = capture();
  const dense = { collect: () => ({ entries: [{ ...SAMPLE[0], port: 3000 }, { ...SAMPLE[0], port: 3001 }], source: 'x', platform: 'test' }) };
  assert.equal(run(['--free', '3000'], c.io, dense), 0);
  assert.equal(c.out(), '3002\n');

  const almostFull = { collect: () => ({ entries: Array.from({ length: 3 }, (_, i) => ({ ...SAMPLE[0], port: 3000 + i })), source: 'x', platform: 'test' }) };
  const capped = { collect: almostFull.collect };
  const c2 = capture();
  assert.equal(run(['--free', '3000'], c2.io, capped), 0);
});

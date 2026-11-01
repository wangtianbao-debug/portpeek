import fs from 'node:fs';
import { collect, findFreePort, ownersOf, sortEntries } from './collect.js';
import { formatCheck, formatJson, formatPlain, formatTable, makeColors } from './format.js';

const HELP = `portpeek — see which process is holding a port

Usage
  portpeek [port] [options]

  Without a port it lists every listening socket. With a port it answers the
  only question that matters: is it free, and if not, who owns it?

Options
  -a, --all           include UDP sockets (default: TCP only)
  -p, --pid <n>       only show sockets owned by this process id
      --free [start]  print the first free port at or above start (default 3000)
      --json          machine-readable output
      --plain         one socket per line, no header
      --no-color      disable colour (also honours NO_COLOR)
  -q, --quiet         print nothing on success
  -h, --help          show this help
  -v, --version       show the version

Exit codes
  0  listed, or the port is free
  1  the port you asked about is in use
  2  bad usage
  3  could not read the socket table

Examples
  portpeek                    # what is listening on this machine?
  portpeek 3000               # is 3000 free? (exit 1 when taken)
  portpeek 3000 && npm start  # only start when the port is free
  portpeek -p 8123            # what is pid 8123 listening on?
  export PORT=$(portpeek --free 4000)
`;

const VALUE_FLAGS = new Set(['-p', '--pid']);

export function parseArgs(argv) {
  const opts = { port: null, all: false, pid: null, free: null, freeStart: 3000, json: false, plain: false, color: null, quiet: false, help: false, version: false };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) return { error: `missing value for ${arg}` };
      const pid = Number(value);
      if (!Number.isInteger(pid) || pid < 0) return { error: `--pid expects a process id, got "${value}"` };
      opts.pid = pid;
      continue;
    }
    if (arg === '--free' || arg === '-f') {
      opts.free = true;
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        opts.freeStart = Number(next);
        i++;
      } else {
        opts.freeStart = 3000;
      }
      continue;
    }
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-v' || arg === '--version') opts.version = true;
    else if (arg === '-a' || arg === '--all') opts.all = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--plain') opts.plain = true;
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '-q' || arg === '--quiet') opts.quiet = true;
    else if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
    else rest.push(arg);
  }

  if (rest.length > 1) return { error: `expected at most one port, got ${rest.length}` };
  if (rest.length === 1) {
    if (!/^\d+$/.test(rest[0])) return { error: `not a port number: "${rest[0]}"` };
    const port = Number(rest[0]);
    if (port < 1 || port > 65535) return { error: `port out of range: ${port}` };
    opts.port = port;
  }
  if (opts.port !== null && opts.free) return { error: 'a port and --free cannot be combined' };
  return { opts };
}

export function run(argv, io = process, deps = {}) {
  const { opts, error } = parseArgs(argv);
  if (error) {
    io.error(`portpeek: ${error}`);
    io.error('run "portpeek --help" for usage');
    return 2;
  }
  if (opts.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    io.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const colorEnabled =
    opts.color ?? (Boolean(io.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb');
  const color = makeColors(colorEnabled);

  let result;
  try {
    result = (deps.collect ?? collect)({ udp: opts.all });
  } catch (err) {
    io.error(`portpeek: ${err.message}`);
    return 3;
  }

  let entries = sortEntries(result.entries);
  const total = entries.length;
  if (opts.pid !== null) entries = entries.filter((e) => e.pid === opts.pid);

  if (opts.free) {
    const port = findFreePort(result.entries, opts.freeStart);
    if (port === null) {
      io.error(`portpeek: no free port above ${opts.freeStart}`);
      return 3;
    }
    io.stdout.write(`${port}\n`);
    return 0;
  }

  if (opts.port !== null) {
    const owners = ownersOf(entries, opts.port);
    if (opts.json) {
      io.stdout.write(`${JSON.stringify({ port: opts.port, taken: owners.length > 0, owners }, null, 2)}\n`);
    } else if (!opts.quiet) {
      io.stdout.write(formatCheck(opts.port, owners, { color }));
    }
    return owners.length ? 1 : 0;
  }

  if (opts.json) {
    io.stdout.write(formatJson(entries, { source: result.source, platform: result.platform }));
    return 0;
  }
  if (!opts.quiet) {
    if (opts.plain) io.stdout.write(formatPlain(entries));
    else io.stdout.write(formatTable(entries, { color, total: opts.pid === null ? null : entries.length }));
  }
  return 0;
}

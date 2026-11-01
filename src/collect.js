import { execFileSync } from 'node:child_process';
import { dedupe, isLoopback, listeningOnly, parseLsof, parseNetstatLinux, parseNetstatWindows, parseSs, parseTasklistCsv } from './parse.js';

const MAX_BUFFER = 64 * 1024 * 1024;

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Ask the operating system which sockets are open.
 *
 * @param {{platform?: string, run?: Function, udp?: boolean}} opts
 * @returns {{entries: object[], source: string, platform: string}}
 */
export function collect({ platform = process.platform, run = defaultRun, udp = false } = {}) {
  if (platform === 'win32') {
    const raw = run('netstat', ['-ano']);
    let names = new Map();
    try {
      names = parseTasklistCsv(run('tasklist', ['/fo', 'csv', '/nh']));
    } catch {
      /* names are a nicety; PIDs still work */
    }
    const entries = dedupe(listeningOnly(parseNetstatWindows(raw))).map((e) => ({
      ...e,
      process: names.get(e.pid) ?? e.process,
    }));
    return { entries: filterProto(entries, udp), source: 'netstat -ano', platform };
  }

  if (platform === 'darwin') {
    const tcp = parseLsof(run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']));
    let all = tcp;
    if (udp) {
      try {
        all = tcp.concat(parseLsof(run('lsof', ['-nP', '-iUDP'])));
      } catch {
        /* UDP blocked by the sandbox: TCP is enough */
      }
    }
    return { entries: dedupe(listeningOnly(all)), source: 'lsof', platform };
  }

  // Linux and other unixes: `ss` is present on any modern system.
  try {
    const raw = run('ss', udp ? ['-lntup'] : ['-lntp']);
    return { entries: dedupe(listeningOnly(parseSs(raw))), source: 'ss', platform };
  } catch {
    /* fall through to netstat for old containers */
  }
  try {
    const raw = run('netstat', udp ? ['-lntup'] : ['-lntp']);
    return { entries: dedupe(listeningOnly(parseNetstatLinux(raw))), source: 'netstat', platform };
  } catch {
    const err = new Error('could not list sockets: neither `ss` nor `netstat` worked');
    err.code = 'ENOCOLLECTOR';
    throw err;
  }
}

function filterProto(entries, udp) {
  return udp ? entries : entries.filter((e) => e.proto === 'tcp');
}

export function sortEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      a.port - b.port ||
      a.proto.localeCompare(b.proto) ||
      String(a.address).localeCompare(String(b.address)) ||
      (a.pid ?? 0) - (b.pid ?? 0),
  );
}

/** Who is listening on `port`? Loopback and wildcard sockets both count. */
export function ownersOf(entries, port) {
  return sortEntries(entries.filter((e) => e.port === Number(port)));
}

/**
 * Does a socket on `entries` block `port` on `host`?
 * A wildcard listener occupies every address; a loopback listener only
 * occupies loopback, so a bind to 0.0.0.0 would still fail.
 */
export function isTaken(entries, port, host = null) {
  return entries.some((e) => {
    if (e.port !== Number(port)) return false;
    if (!host) return true;
    if (e.address === '0.0.0.0' || e.address === '::' || e.address === '*') return true;
    return String(e.address).toLowerCase() === String(host).toLowerCase();
  });
}

/** First port at or above `start` that nothing is listening on. */
export function findFreePort(entries, start = 3000, limit = 1000) {
  const first = Math.max(1, Number(start) || 3000);
  for (let port = first; port < 65536; port++) {
    if (port - first >= limit) break;
    if (!isTaken(entries, port)) return port;
  }
  return null;
}

export { isLoopback };

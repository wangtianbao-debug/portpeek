/**
 * Parsers for the port listings produced by different operating systems.
 *
 * Every parser takes raw command output and returns a list of normalised
 * entries:
 *
 *   { proto, family, address, port, pid, process, state }
 *
 * They are pure functions so the platform-specific mess stays testable on any
 * machine.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/** Split "0.0.0.0:8080", "[::]:8080" or "*:8080" into { address, port }. */
export function splitEndpoint(value) {
  let text = String(value).trim();
  if (!text) return null;

  // IPv6 with brackets: [::1]:8080
  const bracketed = /^\[(.*)\]:(\d+|\*)$/.exec(text);
  if (bracketed) return { address: bracketed[1], port: bracketed[2] === '*' ? null : Number(bracketed[2]) };

  // Bare IPv6 without brackets (ss prints these): :::8080 or ::1:8080
  const tail = /^(.*):(\d+)$/.exec(text);
  if (tail) return { address: tail[1] || '*', port: Number(tail[2]) };
  return null;
}

export function familyOf(address) {
  return String(address).includes(':') ? 'ipv6' : 'ipv4';
}

export function isLoopback(address) {
  return LOOPBACK.has(String(address).toLowerCase());
}

function normalizeState(state) {
  const upper = String(state).toUpperCase();
  return upper === 'LISTENING' ? 'LISTEN' : upper;
}

function entry({ proto, address, port, pid, process, state }) {  return {
    proto,
    family: familyOf(address),
    address,
    port,
    pid: pid === null || pid === undefined || Number.isNaN(pid) ? null : Number(pid),
    process: process || null,
    state: state || '',
  };
}

/* ------------------------------------------------------------------ Windows */

/**
 * Parse `netstat -ano`. Headers are localised, so rows are recognised by shape
 * rather than by column titles.
 */
export function parseNetstatWindows(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    const protoField = fields[0].toLowerCase();
    if (protoField !== 'tcp' && protoField !== 'udp') continue;
    if (fields.length < 4) continue;

    const local = splitEndpoint(fields[1]);
    if (!local || local.port === null) continue;

    // TCP: proto local foreign state pid      UDP: proto local foreign pid
    let state = '';
    let pidText = fields[fields.length - 1];
    if (fields.length >= 5 && !/^\d+$/.test(fields[3])) {
      state = normalizeState(fields[3]);
      pidText = fields[4];
    }
    const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;

    out.push(
      entry({
        proto: protoField,
        address: local.address,
        port: local.port,
        pid,
        state: protoField === 'udp' ? '' : state,
      }),
    );
  }
  return out;
}

/** Parse `tasklist /fo csv /nh`: `"node.exe","1234","Console","1","48,000 K"`. */
export function parseTasklistCsv(text) {
  const names = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;
    const cols = line.match(/"((?:[^"]|"")*)"/g);
    if (!cols || cols.length < 2) continue;
    const name = cols[0].slice(1, -1).replace(/""/g, '"');
    const pid = Number(cols[1].slice(1, -1));
    if (Number.isFinite(pid)) names.set(pid, name);
  }
  return names;
}

/* -------------------------------------------------------------------- Linux */

const SS_STATES = new Set(['LISTEN', 'UNCONN', 'ESTAB', 'ESTABLISHED']);

/** Parse `ss -lntup` (or `ss -tuna`). */
export function parseSs(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^netid\b/i.test(line) || /^state\b/i.test(line)) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 5) continue;

    const proto = fields[0].toLowerCase();
    if (proto !== 'tcp' && proto !== 'udp') continue;

    const stateIndex = SS_STATES.has(fields[1].toUpperCase()) ? 1 : -1;
    const state = stateIndex === 1 ? fields[1].toUpperCase() : '';
    const localIndex = stateIndex === 1 ? 4 : 3;
    const local = splitEndpoint(fields[localIndex] ?? '');
    if (!local || local.port === null) continue;

    const users = /\(\("([^"]+)",pid=(\d+)/.exec(line);
    out.push(
      entry({
        proto,
        address: local.address,
        port: local.port,
        pid: users ? Number(users[2]) : null,
        process: users ? users[1] : null,
        state,
      }),
    );
  }
  return out;
}

/** Parse the Linux `netstat -lntup` table, used when `ss` is missing. */
export function parseNetstatLinux(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    const protoField = fields[0].toLowerCase();
    if (!/^(tcp|udp)6?$/.test(protoField)) continue;
    if (fields.length < 6) continue;

    const local = splitEndpoint(fields[3]);
    if (!local || local.port === null) continue;

    const state = /^[A-Z_]+$/.test(fields[5]) ? fields[5] : '';
    const owner = fields[6] || '';
    const m = /^(\d+)\/(.+)$/.exec(owner);
    out.push(
      entry({
        proto: protoField.replace('6', ''),
        address: local.address,
        port: local.port,
        pid: m ? Number(m[1]) : null,
        process: m ? m[2] : null,
        state,
      }),
    );
  }
  return out;
}

/* -------------------------------------------------------------------- macOS */

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` (and the UDP equivalent). */
export function parseLsof(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^COMMAND\s/.test(line)) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 9) continue;

    const protoField = fields[7].toLowerCase();
    if (protoField !== 'tcp' && protoField !== 'udp') continue;

    const name = fields[8];
    const local = splitEndpoint(name.replace(/\s*\(.*\)$/, ''));
    if (!local || local.port === null) continue;

    const listen = /\(LISTEN\)/.test(line);
    out.push(
      entry({
        proto: protoField,
        address: local.address,
        port: local.port,
        pid: /^\d+$/.test(fields[1]) ? Number(fields[1]) : null,
        process: fields[0],
        state: listen ? 'LISTEN' : '',
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

/** Keep what "an open port" means: TCP listeners and every UDP socket. */
export function listeningOnly(entries) {
  return entries.filter((e) => (e.proto === 'udp' ? true : e.state === 'LISTEN'));
}

export function dedupe(entries) {
  const seen = new Map();
  for (const e of entries) {
    const key = `${e.proto}|${e.address}|${e.port}|${e.pid}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  return [...seen.values()];
}

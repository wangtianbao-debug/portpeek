const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

export function makeColors(enabled) {
  const wrap = (code) => (text) => (enabled ? `${code}${text}${ANSI.reset}` : String(text));
  return {
    reset: wrap(ANSI.reset),
    dim: wrap(ANSI.dim),
    bold: wrap(ANSI.bold),
    red: wrap(ANSI.red),
    green: wrap(ANSI.green),
    yellow: wrap(ANSI.yellow),
    cyan: wrap(ANSI.cyan),
  };
}

function pad(value, width, align = 'left') {
  const text = String(value ?? '');
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}

export function formatTable(entries, { color = makeColors(false), total = null } = {}) {
  if (!entries.length) return `${color.dim('no listening sockets')}\n`;

  const rows = entries.map((e) => [String(e.port), e.proto, String(e.address), e.pid === null ? '-' : String(e.pid), e.process ?? '-']);
  const header = ['PORT', 'PROTO', 'ADDRESS', 'PID', 'PROCESS'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const render = (cells) =>
    [
      pad(cells[0], widths[0], 'right'),
      pad(cells[1], widths[1]),
      pad(cells[2], widths[2]),
      pad(cells[3], widths[3], 'right'),
      pad(cells[4], widths[4]),
    ]
      .join('  ')
      .trimEnd();

  const lines = [color.dim(render(header))];
  for (const cells of rows) {
    lines.push(
      [
        color.cyan(pad(cells[0], widths[0], 'right')),
        pad(cells[1], widths[1]),
        pad(cells[2], widths[2]),
        pad(cells[3], widths[3], 'right'),
        color.dim(pad(cells[4], widths[4])),
      ]
        .join('  ')
        .trimEnd(),
    );
  }

  const count = total ?? entries.length;
  lines.push('', color.dim(`${count} listening socket${count === 1 ? '' : 's'}`));
  return `${lines.join('\n')}\n`;
}

/** One socket per line: `port 3000 tcp 0.0.0.0 pid 8123 node`. */
export function formatPlain(entries) {
  return `${entries
    .map((e) => `${e.port} ${e.proto} ${e.address} pid ${e.pid ?? '-'} ${e.process ?? '-'}`)
    .join('\n')}\n`;
}

export function formatJson(entries, extra = {}) {
  return `${JSON.stringify(
    {
      ...extra,
      sockets: entries.map((e) => ({
        port: e.port,
        proto: e.proto,
        family: e.family,
        address: e.address,
        pid: e.pid,
        process: e.process,
        state: e.state,
      })),
    },
    null,
    2,
  )}\n`;
}

/** `0.0.0.0:80`, `[::]:80` — the way each address is normally written. */
export function endpointOf(entry) {
  const address = entry.family === 'ipv6' ? `[${entry.address}]` : entry.address;
  return `${address}:${entry.port}`;
}

/** Human answer to "can I use port N?". */
export function formatCheck(port, entries, { color = makeColors(false) } = {}) {
  if (!entries.length) return `${color.green('free')}  port ${color.bold(port)} is not in use\n`;
  const owners = entries
    .map((e) => `  ${e.proto} ${endpointOf(e)}  ${e.process ?? 'unknown process'}${e.pid === null ? '' : ` (pid ${e.pid})`}`)
    .join('\n');
  return `${color.red('in use')}  port ${color.bold(port)} is held by\n${owners}\n`;
}

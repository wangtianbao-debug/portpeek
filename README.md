# portpeek

**See which process is holding a port.** One command, every platform, no dependencies.

![node](https://img.shields.io/badge/node-%3E%3D18-3c873a) ![deps](https://img.shields.io/badge/dependencies-0-blue) ![license](https://img.shields.io/badge/license-MIT-black)

```
$ portpeek 3000
in use  port 3000 is held by
  tcp 127.0.0.1:3000  node.exe (pid 8123)
```

## Why

A dev server dies with `EADDRINUSE` and you spend the next five minutes doing this:

```sh
netstat -ano | findstr :3000     # Windows
lsof -i :3000                    # macOS
ss -lntp | grep 3000             # Linux
# …then a second command to turn the PID into a program name
```

`portpeek` does both halves, on every OS, and gets out of the way. It never kills
anything — it tells you what is running and lets you decide.

## Install

Not on npm yet, so clone and link:

```sh
git clone https://github.com/wangtianbao-debug/portpeek.git
cd portpeek
npm link          # puts `portpeek` on your PATH
```

Node 18 or newer. No build step, no runtime dependencies.

## Usage

```
$ portpeek
PORT  PROTO  ADDRESS    PID  PROCESS
 135  tcp    ::        1932  svchost.exe
 135  tcp    0.0.0.0   1932  svchost.exe
 902  tcp    0.0.0.0   6900  vmware-authd.exe
3000  tcp    0.0.0.0   8123  node.exe
…
62 listening sockets
```

Ask about one port — the exit code is the answer, so it composes:

```sh
$ portpeek 3000 && npm start
free  port 3000 is not in use
# npm start runs

$ portpeek 3000 || echo "something else got here first"
in use  port 3000 is held by
  tcp 127.0.0.1:3000  node.exe (pid 8123)
something else got here first
```

Grab a free port instead of hard-coding one:

```sh
$ export PORT=$(portpeek --free 4000)
$ echo $PORT
4000
```

Other things it does:

```sh
portpeek -a              # include UDP sockets
portpeek -p 8123         # everything pid 8123 is listening on
portpeek --json          # { source, platform, sockets: [...] }
portpeek --plain         # one socket per line, for awk/cut
portpeek --free 27000    # first free port at or above 27000
```

### Options

| Option | Description |
| --- | --- |
| `-a`, `--all` | include UDP sockets (default: TCP listeners only) |
| `-p`, `--pid <pid>` | only sockets owned by this process |
| `--free [start]` | print the first free port at or above `start` (default `3000`) |
| `--json` | machine-readable output |
| `--plain` | one socket per line, no header |
| `--no-color` | disable colour (also honours `NO_COLOR`) |
| `-q`, `--quiet` | print nothing on success |
| `-h`, `--help` | full help |
| `-v`, `--version` | version |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | listed, or the port you asked about is free |
| `1` | the port you asked about is in use |
| `2` | bad usage |
| `3` | could not read the socket table |

## How it reads the sockets

| Platform | Command | Notes |
| --- | --- | --- |
| Windows | `netstat -ano` + `tasklist /fo csv /nh` | headers are localised, so rows are matched by shape, not by column title |
| Linux | `ss -lntp` (falls back to `netstat -lntp`) | PID/program column is `-` for processes you do not own |
| macOS | `lsof -nP -iTCP -sTCP:LISTEN` | UDP needs `-a`, and other users' processes need `sudo` |

Everything is read-only. `portpeek` spawns those commands directly (no shell),
parses the output, and prints it.

## Library use

The parsers are pure functions, so you can reuse them without spawning anything:

```js
import { collect, findFreePort, isTaken, parseNetstatWindows } from 'portpeek';

const { entries, source } = collect({ udp: true });
if (isTaken(entries, 3000)) console.log('3000 is busy');
const port = findFreePort(entries, 3000);

// Parse output you captured yourself:
const sockets = parseNetstatWindows(rawNetstatText);
```

`collect({ platform, run })` accepts both overrides, which is how the test suite
covers Windows, Linux and macOS on a single machine.

## Limits worth knowing

- UDP sockets have no state in `netstat`, so they are always reported as open.
- A wildcard listener (`0.0.0.0`, `::`) occupies every interface; a loopback
  listener only occupies loopback. `isTaken(entries, port, host)` models that.
- On Linux, `ss` only shows the PID for processes you own. Run as root to see
  everything.

## Tests

```sh
node --test
```

42 tests, no network access required. Fixtures are verbatim samples from
Windows `netstat`, Linux `ss`, `netstat` and macOS `lsof`, including the
localised-header Windows case.

## CI

GitHub blocks pushing workflows with this token, so the pipeline lives in
[`ci/ci.yml`](ci/ci.yml). Copy it to `.github/workflows/ci.yml` to enable it:
the matrix runs the suite on Ubuntu, Windows and macOS across Node 18, 20, 22
and 24.

## License

MIT

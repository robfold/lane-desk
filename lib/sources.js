'use strict';
// The parts that touch the outside world: Tally CLI and history, the lane-desk config file, Claude session files, tmux, iTerm.
// Secrets (Keychain, tokens, session .key files, process arguments) are not read.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const lr = require('./limitreset');
const { t } = require('./i18n');
const ro = require('./runout');

const HOME = os.homedir();
const BIN_DIRS = [
  ...new Set([
    ...String(process.env.PATH || '').split(':').filter((d) => d.startsWith('/')),
    path.join(HOME, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]),
];
// When launched from Finder, PATH is short. Always give child processes this PATH.
// The launcher's own account folder must not leak into sessions: a default lane sets no -e, and a
// tmux server started from here would hand these on to every session.
const CHILD_ENV = { ...process.env, PATH: [...BIN_DIRS, '/usr/sbin', '/sbin'].join(':') };
delete CHILD_ENV.CLAUDE_CONFIG_DIR;
delete CHILD_ENV.CODEX_HOME;
const TALLY_HELPER = '/Applications/Tally.app/Contents/Helpers/tally';
const TALLY_HISTORY = process.env.LANE_DESK_HISTORY || path.join(HOME, '.tally/history.jsonl');
const CONFIG = process.env.LANE_DESK_CONFIG || path.join(HOME, '.config/lane-desk/config.json');

function expand(p) {
  if (!p) return p;
  return p === '~' || p.startsWith('~/') ? path.join(HOME, p.slice(1)) : p;
}

/** Expand ~ and resolve to the real path. If the path does not exist, use only the absolute path. */
function norm(p) {
  if (!p) return p;
  const abs = path.resolve(expand(p));
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function findBin(name) {
  for (const dir of BIN_DIRS) {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function run(file, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, env: CHILD_ENV, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tallyBin() {
  if (process.env.TALLY_BIN) return process.env.TALLY_BIN;
  return findBin('tally') || (fs.existsSync(TALLY_HELPER) ? TALLY_HELPER : null);
}

async function readStatus() {
  const bin = tallyBin();
  if (!bin) return null;
  const r = await run(bin, ['status', '--json']);
  if (!r.ok) return null;
  try {
    const o = JSON.parse(r.stdout);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** ~/.config/lane-desk/config.json, or {} when it is missing or broken. */
function readConfig() {
  const o = readJson(CONFIG);
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

/** For each Claude account folder Tally knows, read sessions/<pid>.json and keep only claude processes that are actually alive. */
async function readSessions(homes) {
  const found = [];
  for (const home of homes) {
    const dir = path.join(home, 'sessions');
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const o = readJson(path.join(dir, n));
      if (!o || typeof o !== 'object') continue;
      const pid = Number(o.pid || n.split('.')[0]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      // Copy only the needed fields. Values such as peerToken are not carried over.
      const cwd = typeof o.cwd === 'string' ? o.cwd : null;
      const sessionId = typeof o.sessionId === 'string' && /^[0-9a-f-]{8,64}$/i.test(o.sessionId) ? o.sessionId : null;
      found.push({
        pid,
        home,
        name: typeof o.name === 'string' ? o.name : null,
        cwd,
        status: typeof o.status === 'string' ? o.status : null,
        tmux: typeof o.tmux === 'string' ? o.tmux : null,
        updatedAt: Number(o.updatedAt) || 0,
        transcript: transcriptFile(home, cwd, sessionId),
      });
    }
  }
  if (found.length === 0) return [];
  // Also check the executable name (comm) to guard against PID reuse. Arguments are not read.
  const r = await run('/bin/ps', ['-o', 'pid=,comm=', '-p', found.map((s) => s.pid).join(',')]);
  const alive = new Set();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m && /claude/i.test(m[2])) alive.add(Number(m[1]));
  }
  const live = found.filter((s) => alive.has(s.pid));
  for (const s of live) s.wall = s.transcript ? lr.wallOf(tailLines(s.transcript)) : null;
  return live;
}

/** Session transcript path. Claude Code writes to projects/<transformed cwd name>/<sessionId>.jsonl. */
function transcriptFile(home, cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const file = path.join(home, 'projects', lr.projectSlug(cwd), `${sessionId}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

/** The last `bytes` of a file as an array of lines. The first line may be cut off, so it is dropped. */
function tailLines(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// ---- Tally usage history: weekly run-out forecast ----

let historyCache = null; // { mtimeMs, size, value }

/**
 * Reads the last 512KB of ~/.tally/history.jsonl used by Tally (about one week, the same amount as Tally CLI WallForecast)
 * and returns the runout.parseHistory result. If the file is unchanged, it is not read again. If unreadable, null (the view is drawn without the forecast).
 */
function readHistory() {
  let st;
  try {
    st = fs.statSync(TALLY_HISTORY);
  } catch {
    return null;
  }
  if (historyCache && historyCache.mtimeMs === st.mtimeMs && historyCache.size === st.size) return historyCache.value;
  const value = ro.parseHistory(tailLines(TALLY_HISTORY, 512 * 1024));
  historyCache = { mtimeMs: st.mtimeMs, size: st.size, value };
  return value;
}

// ---- /limit-reset: per-account enabled flag and transcript observation ----

const flagCache = new Map(); // file -> { mtimeMs, value }

/**
 * The rollout value tengu_nifty_lemur.enabled cached in the profile settings (.claude.json). Null if absent.
 * Only this one value is extracted. For the default folder (~/.claude), ~/.claude.json is also a candidate and the more recent file is used.
 */
function readResetFlag(home) {
  const candidates = [path.join(home, '.claude.json')];
  if (home === norm('~/.claude')) candidates.push(path.join(HOME, '.claude.json'));
  let best = null;
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
    } catch {
      /* candidate does not exist */
    }
  }
  if (!best) return null;
  const hit = flagCache.get(best.file);
  if (hit && hit.mtimeMs === best.mtimeMs) return hit.value;
  const o = readJson(best.file);
  const pick = (bag) =>
    bag && bag.tengu_nifty_lemur && typeof bag.tengu_nifty_lemur.enabled === 'boolean' ? bag.tengu_nifty_lemur.enabled : null;
  const value = o ? (pick(o.cachedGrowthBookFeatures) ?? pick(o.cachedFeatureFlags)) : null;
  flagCache.set(best.file, { mtimeMs: best.mtimeMs, value });
  return value;
}

const SCAN_DAYS = 8;
const CHUNK = 4 * 1024 * 1024;
const RESET = Buffer.from('reset');

/**
 * For each profile, finds reset sentences in recent transcripts. Remembers the read position per file and reads only newly appended parts.
 * The first scan covers several GB and takes a few seconds, so it runs in the background and does not block refresh.
 */
class ResetScanner {
  constructor() {
    this.files = new Map(); // file -> { home, offset, obs: [] }
    this.running = null;
    this.records = {}; // home -> fold result
    this.ready = false; // whether the first scan has finished
  }

  snapshot() {
    return this.records;
  }

  /** Starts a scan (if one is already running, returns that one). Returns true if the result changed. */
  kick(homes) {
    if (!this.running) {
      this.running = this.scan(homes).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  async scan(homes) {
    const since = Date.now() - SCAN_DAYS * 86400000;
    for (const home of homes) {
      const root = path.join(home, 'projects');
      let dirs = [];
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const d of dirs) {
        let names = [];
        try {
          names = fs.readdirSync(path.join(root, d.name)).filter((n) => n.endsWith('.jsonl'));
        } catch {
          continue;
        }
        for (const n of names) {
          const file = path.join(root, d.name, n);
          let st;
          try {
            st = fs.statSync(file);
          } catch {
            continue;
          }
          if (st.mtimeMs < since) continue;
          let entry = this.files.get(file);
          if (!entry || st.size < entry.offset) entry = { home, offset: 0, obs: [] };
          this.files.set(file, entry);
          if (st.size > entry.offset) await this.readFrom(file, entry, st.size);
        }
      }
    }
    const byHome = {};
    for (const [file, e] of this.files) {
      if (!fs.existsSync(file)) {
        this.files.delete(file);
        continue;
      }
      (byHome[e.home] ||= []).push(...e.obs);
    }
    const next = {};
    for (const home of homes) next[home] = lr.fold(byHome[home] || []);
    const changed = !this.ready || JSON.stringify(next) !== JSON.stringify(this.records);
    this.records = next;
    this.ready = true;
    return changed;
  }

  async readFrom(file, entry, size) {
    const fh = await fs.promises.open(file, 'r');
    try {
      let pos = entry.offset;
      let carry = Buffer.alloc(0);
      while (pos < size) {
        const len = Math.min(CHUNK, size - pos);
        const chunk = Buffer.alloc(len);
        const { bytesRead } = await fh.read(chunk, 0, len, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const lastNl = buf.lastIndexOf(10);
        if (lastNl < 0) {
          carry = buf;
          continue;
        }
        const whole = buf.subarray(0, lastNl + 1);
        carry = Buffer.from(buf.subarray(lastNl + 1));
        let at = whole.indexOf(RESET);
        while (at >= 0) {
          const start = whole.lastIndexOf(10, at) + 1;
          const end = whole.indexOf(10, at);
          const s = lr.signalInLine(whole.toString('utf8', start, end));
          if (s) entry.obs.push(s);
          at = whole.indexOf(RESET, end + 1);
        }
      }
      entry.offset = pos - carry.length; // A tail where the line is not finished is read again next time.
    } finally {
      await fh.close();
    }
  }
}

/** "35:@35.%35" -> "%35". Null if the shape differs. */
function paneOf(tmuxField) {
  const m = String(tmuxField || '').match(/\.(%\d+)$/);
  return m ? m[1] : null;
}

/** Types /limit-reset into that tmux pane's input line and presses Enter. If the pane is in copy mode or dead, nothing is typed. */
async function typeLimitReset(tmuxField) {
  const pane = paneOf(tmuxField);
  if (!pane) return { ok: false, message: t('src.noPaneForSession') };
  if (!tmuxBin()) return { ok: false, message: t('src.noTmux') };
  // display-message succeeds even for a missing pane, so look it up directly in the full pane list.
  const list = await run(tmuxBin(), ['list-panes', '-a', '-F', '#{pane_id} #{pane_in_mode} #{pane_dead}']);
  const row = list.ok ? list.stdout.split('\n').find((l) => l.split(' ')[0] === pane) : null;
  if (!row) return { ok: false, message: t('src.noPane', { pane }) };
  if (row.trim() !== `${pane} 0 0`) {
    return { ok: false, message: t('src.copyMode') };
  }
  const typed = await run(tmuxBin(), ['send-keys', '-t', pane, '-l', lr.COMMAND]);
  if (!typed.ok) return { ok: false, message: t('src.typeFailed', { err: typed.stderr.trim().slice(0, 200) }) };
  await sleep(150);
  const enter = await run(tmuxBin(), ['send-keys', '-t', pane, 'Enter']);
  if (!enter.ok) return { ok: false, message: t('src.enterFailed', { err: enter.stderr.trim().slice(0, 200) }) };
  return { ok: true };
}

/** Waits until command output appears in that session's transcript after `since`. Null if none. */
async function waitResetAnswer(file, since, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(1000);
    const lines = tailLines(file, 256 * 1024);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const s = lr.signalInLine(lines[i]);
      if (s && s.at && s.at >= since - 1000 && s.kind !== 'noticeAvailable') return s;
    }
  }
  return null;
}

function osascriptBin() {
  // An osascript earlier on PATH wins over the system one.
  return findBin('osascript') || '/usr/bin/osascript';
}

function appleString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Runs one shell line in a new iTerm tab (a new window if none is open). */
async function itermRun(line) {
  const script = [
    'tell application id "com.googlecode.iterm2"',
    '  activate',
    '  if (count of windows) = 0 then',
    '    set w to (create window with default profile)',
    `    tell current session of w to write text ${appleString(line)}`,
    '  else',
    '    tell current window',
    '      set t to (create tab with default profile)',
    `      tell current session of t to write text ${appleString(line)}`,
    '    end tell',
    '  end if',
    'end tell',
  ].join('\n');
  return run(osascriptBin(), ['-e', script], { timeout: 15000 });
}

async function itermActivate() {
  return run(osascriptBin(), ['-e', 'tell application id "com.googlecode.iterm2" to activate']);
}

function tmuxBin() {
  return findBin('tmux');
}

async function tmuxClients(target) {
  const r = await run(tmuxBin(), ['list-clients', '-t', `=${target}`, '-F', '#{client_tty}']);
  return r.ok ? r.stdout.split('\n').filter(Boolean).length : 0;
}

/** Keeps only characters usable in a session name (characters safe for both shell and tmux). */
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '');
}

/** A string as one shell word in single quotes. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** A tmux session name as read from a session file: kept exactly, refused if empty or with control characters. */
function sessionName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s) ? s : '';
}

/** Attaches to the tmux session through iTerm and confirms with list-clients that it actually attached. */
async function attachInIterm(target) {
  const tt = sessionName(target);
  if (!tt) return { ok: false, message: t('src.attachEmpty') };
  if (!tmuxBin()) return { ok: false, message: t('src.noTmux') };
  const has = await run(tmuxBin(), ['has-session', '-t', `=${tt}`]);
  if (!has.ok) return { ok: false, message: t('src.noSession', { name: tt }) };
  if ((await tmuxClients(tt)) > 0) {
    await itermActivate();
    return { ok: true, message: t('src.alreadyAttached', { name: tt }) };
  }
  const r = await itermRun(`tmux attach -t ${shQuote(`=${tt}`)}`);
  if (!r.ok) return { ok: false, message: t('src.itermFailed', { err: r.stderr.trim().slice(0, 200) }) };
  for (let i = 0; i < 10; i += 1) {
    await sleep(300);
    if ((await tmuxClients(tt)) > 0) return { ok: true, message: t('src.attached', { name: tt }) };
  }
  return { ok: false, message: t('src.attachUnconfirmed', { name: tt }) };
}

/** Env names a lane may set. Anything else in a lane is ignored. */
const LANE_ENV = new Set(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);

/**
 * Start a new tmux session for a lane ({ label, cmd, env } from model.laneTable) and attach in iTerm.
 * cmd must be a bare command name found on PATH; env values go through tmux -e, never through a shell.
 */
async function openLane(lane) {
  const bin = lane && typeof lane.cmd === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane.cmd) ? findBin(lane.cmd) : null;
  if (!bin) return { ok: false, message: t('src.noCommand', { cmd: (lane && lane.cmd) || '?' }) };
  if (!tmuxBin()) return { ok: false, message: t('src.noTmux') };
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const name = safeName(`desk-${lane.label}-${stamp}`);
  const envArgs = [];
  for (const [k, v] of Object.entries(lane.env || {})) if (LANE_ENV.has(k) && typeof v === 'string') envArgs.push('-e', `${k}=${v}`);
  // tmux runs a one-word command through sh -c, so the path is quoted (a home folder can contain spaces).
  const r = await run(tmuxBin(), ['new-session', '-d', '-s', name, '-c', HOME, ...envArgs, shQuote(bin)]);
  if (!r.ok) return { ok: false, message: t('src.tmuxFailed', { err: r.stderr.trim().slice(0, 200) }) };
  const a = await attachInIterm(name);
  return { ok: a.ok, message: a.ok ? t('src.opened', { lane: lane.label, name }) : t('src.openedNotAttached', { name, why: a.message }) };
}

module.exports = {
  HOME,
  norm,
  readStatus,
  readConfig,
  readSessions,
  readHistory,
  openLane,
  attachInIterm,
  safeName,
  shQuote,
  sessionName,
  readResetFlag,
  ResetScanner,
  typeLimitReset,
  waitResetAnswer,
};

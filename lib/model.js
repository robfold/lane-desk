'use strict';
// Pure functions that turn Tally status into what the window draws. No files, no processes (tested).

const lr = require('./limitreset');
const ro = require('./runout');
const { t } = require('./i18n');

/** Weekly left (%) below which a 5-hour reset is not worth it: the weekly wall comes soon anyway (same rule as Tally). */
const RESET_WEEKLY_FLOOR = 20;

const PROVIDERS = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
];

/** The folder each CLI uses when no env var points elsewhere. */
const DEFAULT_HOMES = { claude: '~/.claude', codex: '~/.codex' };
const HOME_ENV = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

/**
 * How to start a session for each account Tally knows: { real path: lane }.
 * A lane is { label, cmd, env, provider }. `config.lanes` maps an account folder to a command on PATH
 * (for people who already have one wrapper per account). Otherwise the provider's own CLI runs with
 * CLAUDE_CONFIG_DIR / CODEX_HOME pointing at that folder. norm turns a path into its real path.
 */
function laneTable(status, config, norm) {
  const table = {};
  const custom = {};
  for (const [dir, cmd] of Object.entries((config && config.lanes) || {})) {
    if (typeof cmd === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cmd)) custom[norm(dir)] = cmd;
  }
  for (const a of (status && Array.isArray(status.accounts) && status.accounts) || []) {
    if (!a || typeof a.launchHome !== 'string' || !a.launchHome || !HOME_ENV[a.provider]) continue;
    const home = norm(a.launchHome);
    if (custom[home]) {
      table[home] = { label: custom[home], cmd: custom[home], env: {}, provider: a.provider };
      continue;
    }
    const isDefault = home === norm(DEFAULT_HOMES[a.provider]);
    table[home] = {
      label: a.provider,
      cmd: a.provider,
      env: isDefault ? {} : { [HOME_ENV[a.provider]]: home },
      provider: a.provider,
    };
  }
  return table;
}

/** Time left as "1d 20h", "5h 10m", "12m". "passed" when over, null when unknown. */
function fmtLeft(at, now) {
  if (at === null || at === undefined || at === '') return null;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(ms)) return null;
  const mins = Math.floor((ms - now) / 60000);
  if (mins <= 0) return t('time.past');
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Time since as "just now", "3m ago", "2h ago", "1d ago". */
function fmtAgo(at, now) {
  if (!at) return null;
  const mins = Math.floor((now - at) / 60000);
  if (mins < 1) return t('time.now');
  if (mins < 60) return t('time.minAgo', { n: mins });
  if (mins < 1440) return t('time.hourAgo', { n: Math.floor(mins / 60) });
  return t('time.dayAgo', { n: Math.floor(mins / 1440) });
}

function shortPath(p, home) {
  if (!p) return '';
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Menu bar title: "C51 X75". A side with no value shows "-". */
function trayTitle(view) {
  if (!view || view.error) return 'C? X?';
  const pick = (id) => {
    const p = view.providers.find((x) => x.id === id);
    return p && typeof p.remaining === 'number' ? String(p.remaining) : '-';
  };
  return `C${pick('claude')} X${pick('codex')}`;
}

/**
 * Tally's `resetState` (from `tally status --json`) -> the tag state. Anything else says nothing.
 * `notSupported` is left out on purpose. For Claude, Tally reports it without seeing "Unknown command":
 * Tally/Core/ResetOffer.swift:117 is `observed == .unknown && flagsOff == true ? .notEnabled : observed`,
 * so it only means "nothing observed and the cached rollout flags (tengu_nifty_lemur and others) are off".
 * Those flags flip on and off within an hour (one account went notSupported -> unknown in 5 minutes,
 * another unknown -> notSupported), so treating it as "No reset" hid the Reset button for no reason.
 */
const TALLY_RESET = { used: 'used', available: 'available' };

/**
 * The reset tag of one Claude account. flag: the rollout value cached in the profile (true/false/null),
 * record: what the transcripts showed (limitreset.fold result or null),
 * tallyState: Tally's `resetState` for the account (available | used | notSupported | unknown).
 * What Lane Desk saw in the transcripts wins. Tally's used / available fill in only when Lane Desk saw nothing
 * ("No reset" comes only from a real "Unknown command" answer in the transcripts; see TALLY_RESET).
 * With neither, the state is "unknown" and the label is null, so no tag is drawn (Tally draws nothing either).
 */
function resetInfo(flag, record, now, tallyState = null) {
  const eff = lr.effective(record, now);
  // "No reset" from the transcripts only when Claude Code itself answered "Unknown command". The cached
  // rollout value was seen flipping on and off within an hour, so it only goes into the hint text.
  const flagNote = flag === false ? t('reset.flagOff') : '';
  const seen = t('reset.basis.seen');
  if (eff.state === 'notEnabled') {
    return { state: 'off', label: t('reset.off.label'), title: `${t('reset.off.title')}${seen}` };
  }
  if (eff.state === 'used') {
    const left = fmtLeft(eff.nextAt, now);
    return {
      state: 'used',
      label: left ? t('reset.usedLeft.label', { left }) : t('reset.used.label'),
      title: `${left ? t('reset.usedLeft.title') : t('reset.usedNoDate.title')}${seen}`,
    };
  }
  if (eff.state === 'available') {
    return { state: 'available', label: t('reset.available.label'), title: `${t('reset.available.title')}${seen}` };
  }
  const fromTally = Object.hasOwn(TALLY_RESET, tallyState) ? TALLY_RESET[tallyState] : null;
  const byTally = t('reset.basis.tally');
  if (fromTally === 'used') return { state: 'used', label: t('reset.used.label'), title: `${t('reset.tally.used.title')}${byTally}` };
  if (fromTally === 'available') {
    return { state: 'available', label: t('reset.available.label'), title: `${t('reset.tally.available.title')}${byTally}` };
  }
  return { state: 'unknown', label: null, title: `${t('reset.unknown.title')}${flagNote}` };
}

/** The Reset button on a session row. Only for sessions at their 5-hour limit; `why` says what blocks it. */
function sessionReset(s, acc) {
  if (s.wall !== 'session' || !acc || !acc.limitReset || acc.limitReset.state === 'off' || !s.tmux) return null;
  let why = null;
  if (acc.limitReset.state === 'used') why = t('reset.why.used');
  else if (s.status !== 'idle') why = t('reset.why.notIdle');
  else if (typeof acc.weekly.remaining !== 'number' || acc.weekly.remaining < RESET_WEEKLY_FLOOR) {
    why = t('reset.why.weeklyLow', { floor: RESET_WEEKLY_FLOOR });
  }
  return { can: !why, why };
}

const WALL_KEY = { session: 'wall.session', weekly: 'wall.weekly', model: 'wall.model' };

/** Where to get Tally, and how to look at Lane Desk without it. Shown on the first-run screen. */
const TALLY_URL = 'https://github.com/jettoai/tally';
const DEMO_COMMAND = 'LANE_DESK_DEMO=1 npx lane-desk --window';

/**
 * The first-run screen for a Tally problem from sources.readTally: { kind: 'missing' } or
 * { kind: 'failed', command, detail }. Without a problem (status just unusable) it is a failure with no detail.
 */
function setupView(problem) {
  if (problem && problem.kind === 'missing') {
    return {
      error: t('setup.missing.title'),
      setup: { kind: 'missing', tallyUrl: TALLY_URL, demoCommand: DEMO_COMMAND },
      providers: [],
      sessions: [],
    };
  }
  return {
    error: t('setup.failed.title'),
    setup: {
      kind: 'failed',
      command: (problem && problem.command) || null,
      detail: (problem && problem.detail) || t('tally.noAccounts'),
    },
    providers: [],
    sessions: [],
  };
}

/**
 * status: `tally status --json`, lanes: laneTable result,
 * sessions: live Claude sessions ({ pid, home, name, cwd, status, tmux, updatedAt }),
 * norm: path normalizer, home: the user's home folder, now: current time (ms),
 * resets: { profile real path: { flag, record } } (what /limit-reset showed; Tally's own resetState fills the gaps),
 * history: runout.parseHistory result (Tally usage history); without it the forecast is left out,
 * timeZone: time zone for forecast times (default: this Mac's),
 * problem: why status is missing (sources.readTally); it picks the first-run screen.
 */
function buildView({ status, problem = null, lanes = {}, sessions = [], norm = (p) => p, home = '', now = Date.now(), resets = {}, history = null, timeZone }) {
  if (!status || typeof status !== 'object' || !Array.isArray(status.accounts)) return setupView(problem);

  const liveByHome = {};
  for (const s of sessions) liveByHome[s.home] = (liveByHome[s.home] || 0) + 1;

  const accountsById = {};
  const providers = PROVIDERS.map(({ id, name }) => {
    const accounts = status.accounts
      .filter((a) => a && a.provider === id)
      .map((a) => {
        const key = typeof a.launchHome === 'string' && a.launchHome ? norm(a.launchHome) : null;
        const lane = key ? lanes[key] : null;
        const weekly = typeof a.weeklyRemaining === 'number' ? a.weeklyRemaining : null;
        const account = {
          id: a.id || `${id}:${key || a.label}`,
          provider: id,
          label: a.label || t('view.unnamed'),
          home: key,
          lane: lane && lane.provider === id ? lane.label : null,
          laneHome: key ? shortPath(key, home) : null,
          weekly: { remaining: weekly, left: fmtLeft(a.weeklyResetsAt, now) },
          model:
            typeof a.modelRemaining === 'number'
              ? { name: a.modelWindowName || t('view.model'), remaining: a.modelRemaining, left: fmtLeft(a.modelResetsAt, now) }
              : null,
          best: Boolean(a.best),
          exhausted: weekly !== null && weekly <= 0,
          stale: Boolean(a.isStale),
          failed: Boolean(a.lastRefreshFailed),
          live: key ? liveByHome[key] || 0 : 0,
          limitReset: null,
          runout: history
            ? ro.forecast({ remaining: weekly, resetsAt: a.weeklyResetsAt, pace: ro.weeklyPace(history.rows[a.id], history.firstAt, now), now, timeZone })
            : null,
        };
        if (id === 'claude') {
          const r = (key && resets[key]) || {};
          account.limitReset = resetInfo(r.flag ?? null, r.record || null, now, a.resetState ?? null);
        }
        accountsById[account.id] = account;
        return account;
      });
    const fw = status.fleetWeighted && status.fleetWeighted[id];
    const fleet = status.fleet && status.fleet[id];
    const advisor = status.advisor && status.advisor[id];
    return {
      id,
      name,
      remaining: fw && typeof fw.remainingPercent === 'number' ? fw.remainingPercent : null,
      sustainable: fleet ? Boolean(fleet.sustainable) : null,
      headline: advisor && advisor.headline ? advisor.headline : null,
      accounts,
    };
  });

  const accountByHome = {};
  for (const a of Object.values(accountsById)) if (a.home) accountByHome[a.home] = a;

  const sessionRows = sessions
    .map((s) => {
      const acc = accountByHome[s.home];
      const lane = lanes[s.home];
      const wall = s.wall || null;
      return {
        wall,
        wallLabel: wall && WALL_KEY[wall] ? t(WALL_KEY[wall]) : null,
        reset: sessionReset({ ...s, wall }, acc),
        pid: s.pid,
        name: s.name || `pid ${s.pid}`,
        cwd: shortPath(s.cwd, home),
        status: s.status || 'unknown',
        ago: fmtAgo(s.updatedAt, now),
        updatedAt: s.updatedAt || 0,
        account: acc ? acc.label : shortPath(s.home, home),
        lane: lane ? lane.label : null,
        tmux: s.tmux ? String(s.tmux).split(':')[0] : null,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    generatedAt: status.generatedAt || null,
    stale: Boolean(status.stale),
    providers,
    sessions: sessionRows,
  };
}

/** Real paths of the Claude account folders Tally knows (where sessions and transcripts live). */
function claudeHomes(status, norm) {
  const out = new Set();
  for (const a of (status && Array.isArray(status.accounts) && status.accounts) || []) {
    if (a && a.provider === 'claude' && typeof a.launchHome === 'string' && a.launchHome) out.add(norm(a.launchHome));
  }
  return [...out];
}

module.exports = {
  laneTable,
  claudeHomes,
  fmtLeft,
  fmtAgo,
  shortPath,
  trayTitle,
  buildView,
  resetInfo,
  RESET_WEEKLY_FLOOR,
  TALLY_URL,
  DEMO_COMMAND,
};

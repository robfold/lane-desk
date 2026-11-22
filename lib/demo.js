'use strict';
// Made-up accounts for screenshots (LANE_DESK_DEMO=1). Nothing here is read from the machine
// except the home folder path, so paths draw as "~/.claude-work".

const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const H = 3600 * 1000;
const at = (now, hours) => new Date(now + hours * H).toISOString();

const ACCOUNTS = [
  // provider, folder, label, weekly left, hours to weekly reset, model left, pace (% per hour), best
  ['claude', '.claude', 'me@example.com', 9, 93, 90, 1.3, false],
  ['claude', '.claude-work', 'me@work.example', 85, 89, 100, 0.2, true],
  ['claude', '.claude-side', 'side@example.com', 0, 41, 54, 0.9, false],
  ['codex', '.codex', 'me@example.com', 94, 164, null, 0.15, false],
  ['codex', '.codex-work', 'me@work.example', 48, 109, null, 0.35, true],
];

// Codex banked resets as Tally reports them: count, hours to the soonest expiry.
const CODEX_RESETS = { '.codex-work': [2, 190] };

const id = (provider, dir) => `${provider}:${dir}`;

function status(now) {
  const accounts = ACCOUNTS.map(([provider, dir, label, weekly, resetH, model, , best]) => ({
    id: id(provider, dir),
    provider,
    label,
    launchHome: path.join(HOME, dir),
    weeklyRemaining: weekly,
    weeklyResetsAt: at(now, resetH),
    modelRemaining: model,
    modelWindowName: model === null ? undefined : 'Opus',
    modelResetsAt: model === null ? undefined : at(now, resetH),
    best,
    isStale: false,
    lastRefreshFailed: false,
    ...(CODEX_RESETS[dir]
      ? {
          resetState: 'available',
          resetCreditsAvailable: CODEX_RESETS[dir][0],
          resetCreditsNextExpiry: at(now, CODEX_RESETS[dir][1]),
          resetCreditsExpiryUnknown: false,
        }
      : {}),
  }));
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    stale: false,
    accounts,
    fleet: { claude: { sustainable: true }, codex: { sustainable: true } },
    fleetWeighted: { claude: { remainingPercent: 31 }, codex: { remainingPercent: 71 } },
    advisor: {
      claude: { headline: 'near capacity: 3.1 accounts a week over 4 weeks, 3 owned' },
      codex: { headline: 'current accounts are sufficient' },
    },
  };
}

/** A straight-line burn over the last 80 hours that ends at each account's current value. */
function history(now) {
  const rows = {};
  for (const [provider, dir, , weekly, resetH, , pace] of ACCOUNTS) {
    const resetAt = now + resetH * H;
    const end = 100 - weekly;
    const list = [];
    for (let h = 80; h >= 0; h -= 2) {
      const used = Math.max(0, Math.round(end - pace * h));
      if (!list.length || list[list.length - 1].used !== used) list.push({ ts: now - h * H, used, resetAt });
    }
    rows[id(provider, dir)] = list;
  }
  return { rows, firstAt: now - 80 * H };
}

function sessions(now) {
  const s = (pid, dir, name, cwd, status, mins, wall) => ({
    pid,
    home: path.join(HOME, dir),
    name,
    cwd: path.join(HOME, cwd),
    status,
    tmux: `${name}:@1.%1`,
    updatedAt: now - mins * 60000,
    wall,
  });
  return [
    s(41201, '.claude-work', 'billing-refunds', 'code/billing-service', 'idle', 0, 'session'),
    s(41388, '.claude-work', 'docs-site', 'code/docs', 'busy', 1, null),
    s(40977, '.claude', 'api-migration', 'code/api', 'waiting', 6, null),
    s(39812, '.claude', 'release-notes', 'code/api', 'idle', 48, null),
  ];
}

/** One account uses its own wrapper command, to show what config.json lanes look like. */
const config = { lanes: { '~/.claude-work': 'claude-work' } };

module.exports = { status, history, sessions, config };

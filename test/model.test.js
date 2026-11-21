import { describe, it, expect, beforeEach } from 'vitest';
import model from '../lib/model.js';
import { createRequire } from 'node:module';

// The same instance the app code gets from require('./i18n'), so setLang reaches it.
const i18n = createRequire(import.meta.url)('../lib/i18n.js');

const { laneTable, claudeHomes, fmtLeft, fmtAgo, trayTitle, buildView } = model;

const NOW = Date.parse('2026-11-21T00:00:00Z');
const norm = (p) => p.replace(/^~/, '/home/me');

const status = {
  generatedAt: '2026-11-20T23:59:00Z',
  stale: false,
  accounts: [
    { id: 'c1', provider: 'claude', label: 'work', launchHome: '/home/me/.claude-work', weeklyRemaining: 87, weeklyResetsAt: '2026-11-22T20:00:00Z', modelRemaining: 100, modelWindowName: 'Opus', modelResetsAt: '2026-11-21T05:10:00Z', best: true },
    { id: 'c2', provider: 'claude', label: 'side', launchHome: '/home/me/.claude-side', weeklyRemaining: 0, weeklyResetsAt: '2026-11-21T00:12:00Z', modelRemaining: 54 },
    { id: 'c3', provider: 'claude', label: 'personal', launchHome: '/home/me/.claude', weeklyRemaining: 50 },
    { id: 'x1', provider: 'codex', label: 'personal', launchHome: '/home/me/.codex', weeklyRemaining: 100, modelRemaining: null },
    { id: 'x2', provider: 'codex', label: 'work', launchHome: '/home/me/.codex-work', weeklyRemaining: 40 },
    { id: 'g1', provider: 'gemini', label: 'other', launchHome: '/home/me/.gemini', weeklyRemaining: 40 },
  ],
  fleet: { claude: { sustainable: true }, codex: { sustainable: false } },
  fleetWeighted: { claude: { remainingPercent: 51 }, codex: { remainingPercent: 75 } },
  advisor: { claude: { headline: 'near capacity' } },
};
const config = { lanes: { '~/.claude-work': 'claude-work', '~/.claude-side': 'rm -rf /', '~/.codex-work': '..' } };

beforeEach(() => i18n.setLang('en'));

describe('lanes', () => {
  const lanes = laneTable(status, config, norm);

  it('uses the command from config.json for an account folder listed there', () => {
    expect(lanes['/home/me/.claude-work']).toEqual({ label: 'claude-work', cmd: 'claude-work', env: {}, provider: 'claude' });
  });

  it('otherwise runs the provider CLI with its folder env var, and no env for the default folder', () => {
    expect(lanes['/home/me/.claude']).toEqual({ label: 'claude', cmd: 'claude', env: {}, provider: 'claude' });
    expect(lanes['/home/me/.codex']).toEqual({ label: 'codex', cmd: 'codex', env: {}, provider: 'codex' });
    expect(lanes['/home/me/.claude-side'].env).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-side' });
  });

  it('ignores a config value that is not a bare command name', () => {
    expect(lanes['/home/me/.claude-side']).toEqual({ label: 'claude', cmd: 'claude', env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-side' }, provider: 'claude' });
  });

  it('ignores . and .. as command names', () => {
    expect(lanes['/home/me/.codex-work'].cmd).toBe('codex');
  });

  it('skips providers it cannot launch and survives a missing status or config', () => {
    expect(lanes['/home/me/.gemini']).toBeUndefined();
    expect(laneTable(null, null, norm)).toEqual({});
    expect(Object.keys(laneTable(status, undefined, norm))).toHaveLength(5);
  });

  it('lists the Claude account folders for session and transcript scans', () => {
    expect(claudeHomes(status, norm)).toEqual(['/home/me/.claude-work', '/home/me/.claude-side', '/home/me/.claude']);
  });
});

describe('time text', () => {
  it('shortens time left to days, hours, minutes', () => {
    expect(fmtLeft('2026-11-22T20:00:00Z', NOW)).toBe('1d 20h');
    expect(fmtLeft('2026-11-21T05:10:00Z', NOW)).toBe('5h 10m');
    expect(fmtLeft('2026-11-21T00:12:00Z', NOW)).toBe('12m');
  });

  it('says "passed" for a past time and null for none or garbage', () => {
    expect(fmtLeft('2026-11-20T00:00:00Z', NOW)).toBe('passed');
    expect(fmtLeft(null, NOW)).toBeNull();
    expect(fmtLeft('nope', NOW)).toBeNull();
  });

  it('writes time since as "just now", minutes, hours', () => {
    expect(fmtAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(fmtAgo(NOW - 3 * 60_000, NOW)).toBe('3m ago');
    expect(fmtAgo(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
  });

  it('switches to Korean', () => {
    i18n.setLang('ko');
    expect(fmtLeft('2026-11-20T00:00:00Z', NOW)).toBe('지남');
    expect(fmtAgo(NOW - 3 * 60_000, NOW)).toBe('3m 전');
  });
});

describe('building the view', () => {
  const lanes = laneTable(status, config, norm);
  const sessions = [
    { pid: 11, home: '/home/me/.claude-work', name: 'a', cwd: '/home/me/code/api', status: 'busy', tmux: '35:@35.%35', updatedAt: NOW - 60_000 },
    { pid: 12, home: '/home/me/.claude-work', name: 'b', cwd: '/tmp', status: 'idle', tmux: null, updatedAt: NOW - 10_000 },
  ];
  const build = () => buildView({ status, lanes, sessions, home: '/home/me', now: NOW });

  it('gives each account its lane and live session count', () => {
    const claude = build().providers.find((p) => p.id === 'claude');
    const work = claude.accounts.find((a) => a.id === 'c1');
    expect(work).toMatchObject({ lane: 'claude-work', laneHome: '~/.claude-work', live: 2, best: true });
    expect(work.model).toEqual({ name: 'Opus', remaining: 100, left: '5h 10m' });
    expect(claude.accounts.find((a) => a.id === 'c3')).toMatchObject({ lane: 'claude', laneHome: '~/.claude' });
  });

  it('marks an account with 0% weekly as out', () => {
    const claude = build().providers.find((p) => p.id === 'claude');
    expect(claude.accounts.find((a) => a.id === 'c2').exhausted).toBe(true);
  });

  it('shows an account with no lane without one', () => {
    const v = buildView({ status, lanes: {}, home: '/home/me', now: NOW });
    expect(v.providers[0].accounts[0].lane).toBeNull();
  });

  it('gives Codex accounts no model bar', () => {
    const codex = build().providers.find((p) => p.id === 'codex');
    expect(codex.accounts[0].model).toBeNull();
    expect(codex.accounts[0].lane).toBe('codex');
  });

  it('carries the provider total, verdict, and headline', () => {
    const v = build();
    expect(v.providers[0]).toMatchObject({ remaining: 51, sustainable: true, headline: 'near capacity' });
    expect(v.providers[1]).toMatchObject({ remaining: 75, sustainable: false, headline: null });
  });

  it('sorts sessions by last update and adds the tmux session name and a short path', () => {
    const v = build();
    expect(v.sessions.map((s) => s.pid)).toEqual([12, 11]);
    expect(v.sessions[1]).toMatchObject({ tmux: '35', cwd: '~/code/api', account: 'work', lane: 'claude-work', ago: '1m ago' });
  });

  it('shortens both totals into the menu bar title', () => {
    expect(trayTitle(build())).toBe('C51 X75');
  });
});

describe('short paths', () => {
  it('shortens only paths inside the home folder', () => {
    expect(model.shortPath('/home/me/code', '/home/me')).toBe('~/code');
    expect(model.shortPath('/home/me', '/home/me')).toBe('~');
    expect(model.shortPath('/home/meg/code', '/home/me')).toBe('/home/meg/code');
  });
});

describe('when Tally cannot be read', () => {
  it('carries an error and the menu bar shows C? X?', () => {
    const v = buildView({ status: null, now: NOW });
    expect(v.error).toMatch(/Tally/);
    expect(trayTitle(v)).toBe('C? X?');
  });
});

describe('strings', () => {
  it('has the same keys in English and Korean', () => {
    expect(Object.keys(i18n.STRINGS.ko).sort()).toEqual(Object.keys(i18n.STRINGS.en).sort());
  });

  it('picks Korean only for a Korean locale', () => {
    expect(i18n.pick('ko-KR')).toBe('ko');
    expect(i18n.pick('en-US')).toBe('en');
    expect(i18n.pick(undefined)).toBe('en');
  });

  it('fills slots and leaves unknown slots alone', () => {
    expect(i18n.t('ui.accounts', { n: 3 })).toBe(' 3 accounts');
    expect(i18n.t('ui.accounts')).toBe(' {n} accounts');
  });
});

import { describe, it, expect } from 'vitest';
import lr from '../lib/limitreset.js';
import model from '../lib/model.js';
import { createRequire } from 'node:module';

// The same instance the app code gets from require('./i18n'), so setLang reaches it.
const i18n = createRequire(import.meta.url)('../lib/i18n.js');

const { parseStamp, signalInText, signalInLine, fold, effective, wallOf, projectSlug } = lr;
const { buildView, resetInfo } = model;

// 2026-11-21 09:00 KST
const NOW = Date.parse('2026-11-21T00:00:00Z');
const line = (o) => JSON.stringify(o);
const cmdOut = (text, ts = '2026-11-20T03:45:05.868Z') =>
  line({ type: 'system', subtype: 'local_command', content: `<local-command-stdout>${text}</local-command-stdout>`, timestamp: ts });
const wall = (text, ts = '2026-11-21T00:00:00Z') =>
  line({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts });
const said = (text, ts = '2026-11-21T00:00:00Z') =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts });

describe('reading reset sentences', () => {
  it('reads the real output "A 5-hour limit reset isn\'t available right now." as unavailable, not success', () => {
    expect(signalInText("A 5-hour limit reset isn't available right now.").kind).toBe('unavailable');
    expect(signalInText("A session-limit reset isn't available right now.").kind).toBe('unavailable');
  });

  it('reads both the server wording (session) and the default wording (5-hour) as used, with the next date', () => {
    const a = signalInText('Session limit reset · next reset available Nov 27 at 1pm (Asia/Seoul) · your weekly limit still applies', NOW);
    expect(a.kind).toBe('reset');
    expect(new Date(a.nextAt).toISOString()).toBe('2026-11-27T04:00:00.000Z');
    expect(signalInText('5-hour limit reset · next reset available Nov 27 at 1pm (Asia/Seoul)', NOW).kind).toBe('reset');
  });

  it('tells apart an already-used week, a limit notice, and another command\'s Unknown command', () => {
    expect(signalInText('Weekly reset used · available again Nov 25 at 5pm (UTC)', NOW)).toEqual({
      kind: 'alreadyUsed',
      nextAt: Date.parse('2026-11-25T17:00:00Z'),
    });
    expect(signalInText("You've hit your session limit · resets 3pm (Asia/Seoul)\n/limit-reset to reset your session limit now · uses weekly limit · 1/week").kind).toBe('noticeAvailable');
    expect(signalInText('Unknown command: /limit-reset').kind).toBe('notEnabled');
    expect(signalInText('Unknown command: /usgae')).toBeNull();
  });

  it('reads through bold (ANSI) codes', () => {
    expect(signalInText('\u001b[1mSession limit reset\u001b[22m · next reset available 5am (UTC)', NOW).kind).toBe('reset');
  });
});

describe('reading reset times', () => {
  it('takes a bare time as the next such time from now', () => {
    // At 09:00 in Seoul, "5am (Asia/Seoul)" is 05:00 tomorrow
    expect(new Date(parseStamp('available again ', 'available again 5am (Asia/Seoul)', NOW)).toISOString()).toBe('2026-11-21T20:00:00.000Z');
    expect(new Date(parseStamp('resets ', 'resets 11:30am (Asia/Seoul)', NOW)).toISOString()).toBe('2026-11-21T02:30:00.000Z');
  });

  it('returns null for an unknown shape instead of guessing', () => {
    expect(parseStamp('available again ', 'available again next Tuesday', NOW)).toBeNull();
    expect(parseStamp('available again ', 'nothing here', NOW)).toBeNull();
  });
});

describe('filtering transcript lines', () => {
  it('reads only command output and limit notices, not sentences quoted in the conversation', () => {
    expect(signalInLine(cmdOut("A 5-hour limit reset isn't available right now.")).kind).toBe('unavailable');
    expect(signalInLine(said('Session limit reset · next reset available Nov 27 at 1pm (Asia/Seoul)'))).toBeNull();
    expect(signalInLine(line({ type: 'user', message: { content: 'Weekly reset used · available again 5am (UTC)' } }))).toBeNull();
  });

  it('ignores system records that are not local_command even when they contain the words', () => {
    // Quotes inside a JSON string are escaped, so passing the first filter needs another field whose value is "local_command".
    const quoted = line({ type: 'system', subtype: 'informational', origin: 'local_command', content: 'Session limit reset · next reset available 5am (UTC)', timestamp: '2026-11-20T03:45:05Z' });
    expect(signalInLine(quoted)).toBeNull();
  });

  it('decides nothing from the command name line', () => {
    expect(signalInLine(line({ type: 'system', subtype: 'local_command', content: '<command-name>/limit-reset</command-name>', timestamp: '2026-11-20T03:45:05Z' }))).toBeNull();
  });
});

describe('folding an account\'s record', () => {
  it('lets the last sighting win, and a used reset whose date passed comes back as available', () => {
    const rec = fold([
      { kind: 'noticeAvailable', at: NOW - 3000 },
      { kind: 'reset', nextAt: NOW + 3600000, at: NOW - 1000 },
    ]);
    expect(effective(rec, NOW)).toEqual({ state: 'used', nextAt: NOW + 3600000 });
    expect(effective(rec, NOW + 3600000).state).toBe('available');
  });

  it('turns a dateless used into unknown after a week, no sighting into unknown, and try-again changes nothing', () => {
    const rec = fold([{ kind: 'alreadyUsed', nextAt: null, at: NOW }]);
    expect(effective(rec, NOW + 86400000).state).toBe('used');
    expect(effective(rec, NOW + 8 * 86400000).state).toBe('unknown');
    expect(effective(fold([]), NOW).state).toBe('unknown');
    expect(fold([{ kind: 'transient', at: NOW }])).toBeNull();
  });
});

describe('the limit a session is at now', () => {
  it('is session when the last reply is a 5-hour notice, weekly for a weekly one', () => {
    expect(wallOf([said('hi', '2026-11-20T23:00:00Z'), wall("You've hit your session limit · resets 3pm (Asia/Seoul)")], NOW)).toBe('session');
    expect(wallOf([wall("You've hit your weekly limit · resets Nov 23 at 1pm (Asia/Seoul)")], NOW)).toBe('weekly');
  });

  it('is lifted after a normal reply or a reset, or once the notice time has passed', () => {
    expect(wallOf([wall("You've hit your session limit · resets 3pm (Asia/Seoul)"), said('working again')], NOW)).toBeNull();
    expect(wallOf([wall("You've hit your session limit · resets 3pm (Asia/Seoul)"), cmdOut('Session limit reset · next reset available Nov 27 at 1pm (Asia/Seoul)')], NOW)).toBeNull();
    expect(wallOf([wall("You've hit your session limit · resets 8am (Asia/Seoul)", '2026-11-20T20:00:00Z')], NOW)).toBeNull();
  });

  it('turns every character but letters and digits into - in project folder names', () => {
    expect(projectSlug('/Users/me/code/lane-desk')).toBe('-Users-me-code-lane-desk');
  });
});

describe('view: reset tags and buttons', () => {
  const status = {
    accounts: [
      { id: 'c1', provider: 'claude', label: 'work', launchHome: '/h/.claude-a', weeklyRemaining: 87 },
      { id: 'c2', provider: 'claude', label: 'side', launchHome: '/h/.claude-b', weeklyRemaining: 10 },
      { id: 'c3', provider: 'claude', label: 'personal', launchHome: '/h/.claude', weeklyRemaining: 90 },
      { id: 'x1', provider: 'codex', label: 'personal', launchHome: '/h/.codex', weeklyRemaining: 100 },
    ],
  };
  const session = (pid, home, extra) => ({ pid, home, name: `s${pid}`, cwd: '/h', status: 'idle', tmux: `${pid}:@${pid}.%${pid}`, updatedAt: NOW - pid, ...extra });
  const v = buildView({
    status,
    now: NOW,
    resets: {
      '/h/.claude-a': { flag: true, record: null },
      '/h/.claude-b': { flag: true, record: null },
      '/h/.claude': { flag: false, record: null },
    },
    sessions: [
      session(1, '/h/.claude-a', { wall: 'session' }),
      session(2, '/h/.claude-a', { wall: 'session', status: 'busy' }),
      session(3, '/h/.claude-b', { wall: 'session' }),
      session(4, '/h/.claude', { wall: 'session' }),
      session(5, '/h/.claude-a', { wall: 'weekly' }),
      session(6, '/h/.claude-a', {}),
    ],
  });
  const acc = (id) => v.providers.flatMap((p) => p.accounts).find((a) => a.id === id);
  const row = (pid) => v.sessions.find((s) => s.pid === pid);

  it('tags only Claude accounts; a rollout value of off adds a hint but does not block', () => {
    expect(acc('c1').limitReset).toMatchObject({ state: 'unknown', label: null });
    expect(acc('c3').limitReset.state).toBe('unknown');
    expect(acc('c3').limitReset.title).toMatch(/cached rollout value for this login is off/);
    expect(acc('x1').limitReset).toBeNull();
  });

  it('shows No reset, and no button, only for a login that answered Unknown command', () => {
    expect(resetInfo(true, { state: 'notEnabled', nextAt: null, at: NOW }, NOW).state).toBe('off');
  });

  it('enables Reset only for idle sessions at their 5-hour limit', () => {
    expect(row(1).reset).toEqual({ can: true, why: null });
    expect(row(1).wallLabel).toBe('5-hour limit');
    expect(row(2).reset.can).toBe(false);
    expect(row(3).reset.why).toMatch(/20%/);
    expect(row(4).reset).toEqual({ can: true, why: null });
    expect(row(5).reset).toBeNull();
    expect(row(6).reset).toBeNull();
  });

  it('blocks the button for an account that used this week\'s reset and shows the time left', () => {
    const info = resetInfo(true, { state: 'used', nextAt: NOW + 2 * 3600000, at: NOW }, NOW);
    expect(info.label).toBe('Reset used · 2h 0m');
  });
});

describe('view: reset tags from Tally resetState', () => {
  const used2h = { state: 'used', nextAt: NOW + 2 * 3600000, at: NOW };

  it('uses Tally notSupported as No reset when Lane Desk saw nothing', () => {
    const info = resetInfo(null, null, NOW, 'notSupported');
    expect(info).toMatchObject({ state: 'off', label: 'No reset' });
    expect(info.title).toMatch(/Source: Tally/);
  });

  it('uses Tally used as Reset used without a time, since Tally gives no date', () => {
    expect(resetInfo(null, null, NOW, 'used')).toMatchObject({ state: 'used', label: 'Reset used' });
  });

  it('uses Tally available as Reset left', () => {
    expect(resetInfo(null, null, NOW, 'available')).toMatchObject({ state: 'available', label: 'Reset left' });
  });

  it('lets what Lane Desk saw in the transcripts win over Tally', () => {
    const info = resetInfo(null, used2h, NOW, 'available');
    expect(info).toMatchObject({ state: 'used', label: 'Reset used · 2h 0m' });
    expect(info.title).toMatch(/Lane Desk saw this/);
    expect(resetInfo(null, { state: 'notEnabled', nextAt: null, at: NOW }, NOW, 'available').state).toBe('off');
    expect(resetInfo(null, { state: 'available', nextAt: null, at: NOW }, NOW, 'notSupported').state).toBe('available');
  });

  it('falls back to Tally when the transcripts only said "not right now"', () => {
    expect(resetInfo(null, { state: 'unknown', nextAt: null, at: NOW }, NOW, 'notSupported').state).toBe('off');
  });

  it('draws no tag when neither Lane Desk nor Tally knows', () => {
    for (const tally of ['unknown', null, undefined, 'somethingNew', '__proto__']) {
      expect(resetInfo(null, null, NOW, tally)).toMatchObject({ state: 'unknown', label: null });
    }
  });

  it('reads resetState from tally status, and keeps the button rules', () => {
    const status = {
      accounts: [
        { id: 'c1', provider: 'claude', label: 'a', launchHome: '/h/.claude-a', weeklyRemaining: 90, resetState: 'notSupported' },
        { id: 'c2', provider: 'claude', label: 'b', launchHome: '/h/.claude-b', weeklyRemaining: 90, resetState: 'used' },
        { id: 'c3', provider: 'claude', label: 'c', launchHome: '/h/.claude-c', weeklyRemaining: 90, resetState: 'unknown' },
        { id: 'x1', provider: 'codex', label: 'x', launchHome: '/h/.codex', weeklyRemaining: 90, resetState: 'available' },
      ],
    };
    const at = (pid, home) => ({ pid, home, name: `s${pid}`, cwd: '/h', status: 'idle', tmux: `${pid}:@${pid}.%${pid}`, updatedAt: NOW - pid, wall: 'session' });
    const v = buildView({ status, now: NOW, sessions: [at(1, '/h/.claude-a'), at(2, '/h/.claude-b'), at(3, '/h/.claude-c')] });
    const acc = (id) => v.providers.flatMap((p) => p.accounts).find((a) => a.id === id);
    const row = (pid) => v.sessions.find((s) => s.pid === pid);
    expect(acc('c1').limitReset).toMatchObject({ state: 'off', label: 'No reset' });
    expect(acc('c2').limitReset).toMatchObject({ state: 'used', label: 'Reset used' });
    expect(acc('c3').limitReset).toMatchObject({ state: 'unknown', label: null });
    expect(acc('x1').limitReset).toBeNull();
    expect(row(1).reset).toBeNull();
    expect(row(2).reset).toMatchObject({ can: false });
    expect(row(3).reset).toEqual({ can: true, why: null });
  });

  it('says it in Korean too', () => {
    i18n.setLang('ko');
    try {
      const info = resetInfo(null, null, NOW, 'notSupported');
      expect(info.label).toBe('리셋 없음');
      expect(info.title).toMatch(/근거: Tally/);
    } finally {
      i18n.setLang('en');
    }
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import ro from '../lib/runout.js';
import model from '../lib/model.js';
import { createRequire } from 'node:module';

// The same instance the app code gets from require('./i18n'), so setLang reaches it.
const i18n = createRequire(import.meta.url)('../lib/i18n.js');

const { parseHistory, consumption, weeklyPace, forecast, fmtWhen } = ro;

const H = 3600 * 1000;
const NOW = Date.parse('2026-11-21T12:00:00Z'); // Sat 21:00 in Seoul
const RESET = Date.parse('2026-11-25T04:00:00Z'); // Wed 13:00 in Seoul
const at = (hoursAgo) => NOW - hoursAgo * H;
const s = (hoursAgo, used, resetAt = RESET) => ({ ts: at(hoursAgo), used, resetAt });

beforeEach(() => i18n.setLang('en'));

describe('reading Tally history', () => {
  it('keeps only the weekly window, per account, in time order, and skips broken lines', () => {
    const lines = [
      JSON.stringify({ account: 'claude:.a', window: 'weeklyAll', ts: '2026-11-21T02:00:00Z', used: 12, resetAt: '2026-11-25T04:00:00Z' }),
      '{"account":"claude:.a", broken line',
      JSON.stringify({ account: 'claude:.a', window: 'weeklyAll', ts: '2026-11-21T01:00:00Z', used: 10, resetAt: '2026-11-25T03:59:00Z' }),
      JSON.stringify({ account: 'claude:.a', window: 'session', ts: '2026-11-20T20:00:00Z', used: 40 }),
      JSON.stringify({ account: 'codex:.b', window: 'weeklyAll', ts: '2026-11-21T03:00:00.250Z', used: 5 }),
      '',
    ];
    const h = parseHistory(lines);
    expect(h.rows['claude:.a'].map((r) => r.used)).toEqual([10, 12]);
    expect(h.rows['codex:.b'][0].resetAt).toBeNull();
    // The time the history covers starts at its earliest line, whatever the window.
    expect(h.firstAt).toBe(Date.parse('2026-11-20T20:00:00Z'));
  });
});

describe('consumption (port of Tally UsageAdvisorMath.consumption)', () => {
  it('adds only what went up inside one cycle', () => {
    expect(consumption([s(10, 10), s(8, 14), s(2, 20)])).toBe(10);
  });

  it('does not read a reset time that drifts by a minute as a reset', () => {
    const jitter = [s(10, 10, RESET), s(8, 14, RESET - 60_000), s(2, 20, RESET)];
    expect(consumption(jitter)).toBe(10);
  });

  it('does not bill a one-poll reading from the previous cycle (Tally: codex 2026-09-09)', () => {
    const blip = [s(10, 10), s(9, 42, RESET - 7 * 24 * H), s(8, 12)];
    expect(consumption(blip)).toBe(2);
  });

  it('counts everything spent in the new cycle after a real reset', () => {
    const next = RESET + 7 * 24 * H;
    const rolled = [s(10, 90), s(6, 3, next), s(4, 8, next)];
    // Up to 90 is the old cycle (the first sample is the baseline); the new cycle adds 3 + 5.
    expect(consumption(rolled)).toBe(8);
  });

  it('counts from the second low reading when the counter restarts without its reset time moving (Tally: claude2 2026-09-24)', () => {
    const restart = [s(10, 80), s(8, 2), s(6, 5), s(4, 9)];
    expect(consumption(restart)).toBe(7);
  });

  it('uses samples before `since` only as a baseline', () => {
    expect(consumption([s(100, 10), s(80, 30), s(50, 35), s(10, 50)], at(72))).toBe(20);
  });
});

describe('weekly pace', () => {
  it('is null (measuring) while the history is under 6 hours', () => {
    expect(weeklyPace([s(3, 10), s(1, 12)], at(5), NOW)).toBeNull();
    expect(weeklyPace([], null, NOW)).toBeNull();
  });

  it('divides what was spent in the last 72 hours by the hours covered', () => {
    const p = weeklyPace([s(100, 0), s(73, 10), s(36, 28), s(0, 46)], at(200), NOW);
    expect(p.hours).toBe(72);
    expect(p.perHour).toBeCloseTo(36 / 72, 6);
  });

  it('divides by the shorter span when the history is under 72 hours', () => {
    const p = weeklyPace([s(12, 0), s(0, 12)], at(24), NOW);
    expect(p.hours).toBe(24);
    expect(p.perHour).toBeCloseTo(0.5, 6);
  });
});

describe('forecast', () => {
  const tz = 'Asia/Seoul';

  it('says before, with the time, when it runs out before the reset', () => {
    // 9% left at 0.5% an hour → 18 hours (Sun 15:00 Seoul); the reset is Wed 13:00 Seoul
    const f = forecast({ remaining: 9, resetsAt: RESET, pace: { perHour: 0.5, hours: 72 }, now: NOW, timeZone: tz });
    expect(f.state).toBe('before');
    expect(f.label).toBe('Runs out Sun 15:00');
    expect(f.title).toContain('Wed 13:00');
  });

  it('is safe when it would run out after the reset', () => {
    const f = forecast({ remaining: 85, resetsAt: '2026-11-25T04:00:00Z', pace: { perHour: 0.5, hours: 72 }, now: NOW, timeZone: tz });
    expect(f.state).toBe('safe');
    expect(f.label).toBe('Lasts until reset');
  });

  it('is safe for an account not used lately', () => {
    expect(forecast({ remaining: 50, resetsAt: RESET, pace: { perHour: 0, hours: 72 }, now: NOW }).state).toBe('safe');
  });

  it('shows nothing extra when already out, none without a value, measuring with short history', () => {
    expect(forecast({ remaining: 0, resetsAt: RESET, pace: { perHour: 1, hours: 72 }, now: NOW })).toMatchObject({ state: 'out', label: null });
    expect(forecast({ remaining: null, resetsAt: RESET, pace: null, now: NOW })).toMatchObject({ state: 'none', label: null });
    expect(forecast({ remaining: 50, resetsAt: RESET, pace: null, now: NOW }).state).toBe('measuring');
  });

  it('is before when the reset time is unknown', () => {
    expect(forecast({ remaining: 10, resetsAt: null, pace: { perHour: 1, hours: 72 }, now: NOW }).state).toBe('before');
  });

  it('writes a time as weekday and 24-hour clock', () => {
    expect(fmtWhen(Date.parse('2026-11-25T13:05:00Z'), tz)).toBe('Wed 22:05');
  });

  it('writes Korean labels in Korean', () => {
    i18n.setLang('ko');
    const f = forecast({ remaining: 9, resetsAt: RESET, pace: { perHour: 0.5, hours: 72 }, now: NOW, timeZone: tz });
    expect(f.label).toBe('일 15:00 바닥 예상');
    expect(f.title).toContain('리셋(수 13:00) 전에');
  });
});

describe('in the view', () => {
  const status = {
    accounts: [
      { id: 'claude:.claude', provider: 'claude', label: 'personal', weeklyRemaining: 9, weeklyResetsAt: '2026-11-25T08:00:00Z' },
      { id: 'claude:.claude-work', provider: 'claude', label: 'work', weeklyRemaining: 85, weeklyResetsAt: '2026-11-25T04:00:00Z' },
    ],
  };
  const history = {
    firstAt: at(200),
    rows: {
      'claude:.claude': [s(72, 40, Date.parse('2026-11-25T08:00:00Z')), s(0, 91, Date.parse('2026-11-25T08:00:00Z'))],
      'claude:.claude-work': [s(72, 10), s(0, 15)],
    },
  };

  it('adds a runout to each account', () => {
    const v = model.buildView({ status, history, now: NOW, timeZone: 'Asia/Seoul' });
    const [personal, work] = v.providers[0].accounts;
    expect(personal.runout.state).toBe('before');
    expect(work.runout.state).toBe('safe');
  });

  it('draws without a runout when the history cannot be read', () => {
    const v = model.buildView({ status, now: NOW });
    expect(v.providers[0].accounts[0].runout).toBeNull();
  });
});

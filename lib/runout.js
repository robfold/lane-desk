'use strict';
// Weekly run-out forecast per account. Pure functions: no files, no processes (tested).
//
// Ported from Tally (https://github.com/jettoai/tally, MIT, Copyright (c) Jetto — see NOTICE):
// - History: `~/.tally/history.jsonl`, one line per (account, window) each time a value moves
//   (Tally/Core/UsageHistory.swift).
// - Consumption: a port of `UsageAdvisor.consumption` (TallyCLI/UsageAdvisorMath.swift). It tolerates
//   reset times that drift by a minute (5 minutes allowed), a one-poll reading from another cycle
//   (held until the next sample confirms it), and a counter that restarts without its reset time moving.
// - Pace: the same frame as `FleetForecast.weeklyRates` (Tally/Core/FleetForecast.swift): what was
//   spent in the last 72 hours divided by the hours covered (72, or less if the history is shorter);
//   under 6 hours reads as "measuring". Tally does this for the whole fleet; this file does it per account.

const { t, getLang } = require('./i18n');

const WEEKLY_WINDOW = 'weeklyAll';
const LOOKBACK_HOURS = 72; // FleetForecast.lookbackHours
const MIN_SAMPLE_HOURS = 6; // FleetForecast.minimumSampleHours
const RESET_TOLERANCE_MS = 5 * 60 * 1000; // UsageAdvisor.resetTolerance
const RESTART_DROP = 10; // UsageAdvisor.restartDrop
const HOUR = 3600 * 1000;

function parseTs(s) {
  if (typeof s !== 'string') return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * history.jsonl lines → { rows: { account id: [samples] }, firstAt }.
 * Keeps only the account-wide weekly window (weeklyAll) as { ts, used, resetAt } in ms. Broken lines are skipped.
 * firstAt is the earliest time in what was read, across every window and account; it measures how much
 * time the history covers.
 */
function parseHistory(lines) {
  const rows = {};
  let firstAt = null;
  for (const line of lines || []) {
    if (!line) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') continue;
    const ts = parseTs(r.ts);
    if (ts === null) continue;
    if (firstAt === null || ts < firstAt) firstAt = ts;
    if (r.window !== WEEKLY_WINDOW || typeof r.account !== 'string' || typeof r.used !== 'number') continue;
    (rows[r.account] ||= []).push({ ts, used: r.used, resetAt: parseTs(r.resetAt) });
  }
  for (const list of Object.values(rows)) list.sort((a, b) => a.ts - b.ts);
  return { rows, firstAt };
}

/**
 * Percentage points spent since `since` in one account's window (samples in time order).
 * A port of Tally's UsageAdvisorMath.consumption. Samples before `since` serve only as a baseline.
 */
function consumption(samples, since = -Infinity) {
  let total = 0;
  let cycle = null; // the reset time anchoring the cycle being watched
  let watermark = 0; // the highest `used` seen inside it
  let previous = null;
  let held = null; // a reading whose reset jumped, waiting for the next sample to confirm it
  for (const sample of samples) {
    if (!previous) {
      cycle = sample.resetAt;
      watermark = sample.used;
      previous = sample;
      continue;
    }
    let prior = previous;
    if (held) {
      const waiting = held;
      held = null;
      if (sample.resetAt !== null && waiting.resetAt !== null && Math.abs(sample.resetAt - waiting.resetAt) <= RESET_TOLERANCE_MS) {
        // Confirmed: the held reading opens a new cycle. The rollover happened between two samples,
        // so what it shows was already spent.
        cycle = waiting.resetAt;
        watermark = waiting.used;
        if (waiting.ts >= since) total += waiting.used;
        prior = waiting;
      }
    }
    if (sample.resetAt !== null && cycle !== null && Math.abs(sample.resetAt - cycle) > RESET_TOLERANCE_MS) {
      held = sample; // another cycle's value: the next sample decides whether it was a blip or a real reset
      continue;
    }
    previous = sample;
    if (sample.resetAt !== null) cycle = sample.resetAt; // follow the drift so minute steps never add up to a false reset
    let step;
    if (sample.resetAt !== null && sample.used <= watermark - RESTART_DROP && prior.used <= watermark - RESTART_DROP) {
      // The counter restarted without its reset time moving: count only the growth from the second low reading.
      step = Math.max(0, sample.used - prior.used);
    } else {
      if (!(sample.used > watermark)) continue;
      step = sample.used - watermark;
    }
    watermark = sample.used;
    if (sample.ts < since || !(step > 0)) continue;
    total += step;
  }
  return total;
}

/** Recent weekly pace of one account (% per hour), or null while the history is under 6 hours ("measuring"). */
function weeklyPace(samples, firstAt, now) {
  if (firstAt === null || firstAt === undefined) return null;
  const hours = Math.min(LOOKBACK_HOURS, (now - firstAt) / HOUR);
  if (!(hours >= MIN_SAMPLE_HOURS)) return null;
  const since = now - LOOKBACK_HOURS * HOUR;
  return { perHour: consumption(samples || [], since) / hours, hours };
}

const WEEKDAYS = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ko: ['일', '월', '화', '수', '목', '금', '토'],
};

/** A time as "Wed 22:00" (or "수 22:00"). Without timeZone, this Mac's zone. */
function fmtWhen(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const wd = WEEKDAYS.en.indexOf(get('weekday'));
  const names = WEEKDAYS[getLang()] || WEEKDAYS.en;
  return `${names[wd] ?? ''} ${get('hour')}:${get('minute')}`.trim();
}

/**
 * The forecast for one account.
 * remaining: weekly % left, resetsAt: weekly reset time (ms or ISO), pace: weeklyPace result.
 * state: before (runs out before the reset) · safe (lasts until the reset) · measuring (not enough history)
 *        · out (already empty) · none (no value)
 */
function forecast({ remaining, resetsAt, pace, now, timeZone }) {
  if (typeof remaining !== 'number') return { state: 'none', label: null, title: null };
  if (remaining <= 0) return { state: 'out', label: null, title: null };
  if (!pace) {
    return { state: 'measuring', label: t('runout.measuring'), title: t('runout.measuring.title', { hours: MIN_SAMPLE_HOURS }) };
  }
  const reset = typeof resetsAt === 'number' ? resetsAt : parseTs(resetsAt);
  const basis = t('runout.basis', { hours: Math.round(pace.hours), rate: pace.perHour.toFixed(2) });
  if (!(pace.perHour > 0)) {
    return { state: 'safe', label: t('runout.safe'), title: t('runout.idle.title', { basis }) };
  }
  const dryAt = now + (remaining / pace.perHour) * HOUR;
  if (reset !== null && dryAt >= reset) {
    return { state: 'safe', label: t('runout.safe'), title: t('runout.safe.title', { basis, when: fmtWhen(dryAt, timeZone) }), dryAt };
  }
  return {
    state: 'before',
    label: t('runout.before', { when: fmtWhen(dryAt, timeZone) }),
    title: t('runout.before.title', { basis, reset: reset !== null ? t('runout.resetAt', { when: fmtWhen(reset, timeZone) }) : '' }),
    dryAt,
  };
}

module.exports = { parseHistory, consumption, weeklyPace, forecast, fmtWhen, LOOKBACK_HOURS, MIN_SAMPLE_HOURS };

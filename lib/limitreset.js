'use strict';
// Pure functions that observe Claude Code's `/limit-reset` (a command that lifts the 5-hour limit immediately, once a week) from session transcripts.
// They do not touch files or processes (this is what the tests cover).
//
// The rules match the Tally original (jettoai/tally `Tally/Core/LimitReset.swift`, `TallyCLI/LimitResetSignals.swift`).
// - There is no API. State comes only from sentences Claude Code printed. If none was ever seen, the state is "unknown".
// - Only two kinds of records written by Claude Code itself are read: slash command output (system/local_command) and
//   limit notices (isApiErrorMessage). Conversation text is not read, because it may quote these sentences.
// - The wording is "session limit" from the server config (tengu_nifty_lemur) and "5-hour limit" from the binary default. Both are accepted.

const COMMAND = '/limit-reset';

const PHRASE = {
  reset: ['Session limit reset', '5-hour limit reset'],
  resetNext: 'next reset available ',
  alreadyUsed: 'Weekly reset used',
  usedAgain: 'available again ',
  unavailable: ["session-limit reset isn't available right now", "5-hour limit reset isn't available right now"],
  loginRequired: ["Couldn't reset your session limit with this login", "Couldn't reset your 5-hour limit with this login"],
  transient: ["Couldn't reset your session limit right now", "Couldn't reset your 5-hour limit right now"],
  inProgress: ['Your session limit is already being reset', 'Your 5-hour limit is already being reset'],
  notice: ['to reset your session limit now', 'to reset your 5-hour limit now'],
  unknownCommand: 'Unknown command',
};

/** A single reset that is older than this period goes back to "unknown" (weekly cycle). */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const has = (text, list) => list.some((p) => text.includes(p));

function plain(raw) {
  return String(raw).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''); // Strip ANSI escape sequences such as bold.
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function zoneParts(t, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month - 1, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** The instant (ms) at which the clock in tz reads y-mo-d h:mi. */
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const offsetAt = (t) => {
    const p = zoneParts(t, tz);
    return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  let t = guess - offsetAt(guess);
  const second = guess - offsetAt(t);
  if (second !== t) t = second; // Correct for the daylight saving boundary
  return t;
}

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined; // Unknown name: use this machine's time zone
  }
}

const hour24 = (h, ampm) => (h % 12) + (ampm === 'pm' ? 12 : 0);

/**
 * Reads the time (ms) from "...{marker}Nov 23 at 1pm (Asia/Seoul)..." or "...{marker}4:20pm (Asia/Seoul)...".
 * Any other shape returns null (no guessing). If only a time is given, it is the nearest such time after now.
 */
function parseStamp(marker, text, now) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  const tail = text.slice(i + marker.length);
  const zm = tail.match(/\(([^)]+)\)/);
  const tz = zm ? validZone(zm[1]) : undefined;
  const dated = tail.match(/^([A-Z][a-z]{2}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm)/);
  if (dated) {
    const mo = MONTHS.indexOf(dated[1]);
    if (mo < 0) return null;
    const h = hour24(Number(dated[3]), dated[5]);
    const mi = Number(dated[4] || 0);
    const y = zoneParts(now, tz).y;
    const options = [y - 1, y, y + 1].map((yy) => zonedToUtc(yy, mo, Number(dated[2]), h, mi, tz));
    return options.reduce((a, b) => (Math.abs(b - now) < Math.abs(a - now) ? b : a));
  }
  const timeOnly = tail.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)/);
  if (!timeOnly) return null;
  const h = hour24(Number(timeOnly[1]), timeOnly[3]);
  const mi = Number(timeOnly[2] || 0);
  for (let k = 0; k <= 8; k += 1) {
    const p = zoneParts(now + k * 86400000, tz);
    const t = zonedToUtc(p.y, p.mo, p.d, h, mi, tz);
    if (t >= now) return t;
  }
  return null;
}

/**
 * What one sentence printed by Claude Code says about the reset. Null if unrelated. Order is priority.
 * "Unavailable" is checked before success. A real output "A 5-hour limit reset isn't available right now."
 * (2026-11-20, observed on one machine's profile) contains the success phrase "5-hour limit reset".
 */
function signalInText(raw, now = Date.now()) {
  const text = plain(raw);
  if (has(text, PHRASE.unavailable)) return { kind: 'unavailable' };
  if (has(text, PHRASE.reset)) return { kind: 'reset', nextAt: parseStamp(PHRASE.resetNext, text, now) };
  if (text.includes(PHRASE.alreadyUsed)) return { kind: 'alreadyUsed', nextAt: parseStamp(PHRASE.usedAgain, text, now) };
  if (has(text, PHRASE.loginRequired)) return { kind: 'loginRequired' };
  if (has(text, PHRASE.transient)) return { kind: 'transient' };
  if (has(text, PHRASE.inProgress)) return { kind: 'inProgress' };
  // Other slash command typos also produce the same "Unknown command", so check it only for this command.
  if (text.includes(PHRASE.unknownCommand) && text.includes(COMMAND)) return { kind: 'notEnabled' };
  if (has(text, PHRASE.notice)) return { kind: 'noticeAvailable' };
  return null;
}

/** Cheap filter applied before parsing a raw line as JSON. Every phrase contains "reset". */
function worthParsing(line) {
  return line.includes('reset') && (line.includes('"local_command"') || line.includes('"isApiErrorMessage":true'));
}

/** Text of records written by Claude Code itself. Conversation text (human, model, tool) gives an empty array. */
function productTexts(o) {
  const texts = [];
  if (!o || typeof o !== 'object') return texts;
  if (o.type === 'system' && o.subtype === 'local_command' && typeof o.content === 'string') texts.push(o.content);
  if (o.isApiErrorMessage === true && o.message && typeof o.message === 'object') {
    const c = o.message.content;
    if (typeof c === 'string') texts.push(c);
    else if (Array.isArray(c)) for (const part of c) if (part && typeof part.text === 'string') texts.push(part.text);
  }
  return texts;
}

/** One transcript line -> { kind, nextAt, at } or null. */
function signalInLine(line, now = Date.now()) {
  if (!worthParsing(line)) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const at = Date.parse(o.timestamp) || null;
  for (const text of productTexts(o)) {
    const s = signalInText(text, at || now);
    if (s) return { ...s, at };
  }
  return null;
}

/** Fold observations in time order into one record per account. inProgress and transient decide nothing. */
function fold(observations) {
  let rec = null;
  const sorted = [...observations].filter((o) => o && o.at).sort((a, b) => a.at - b.at);
  for (const o of sorted) {
    if (o.kind === 'reset' || o.kind === 'alreadyUsed') rec = { state: 'used', nextAt: o.nextAt || null, at: o.at };
    else if (o.kind === 'noticeAvailable') rec = { state: 'available', nextAt: null, at: o.at };
    else if (o.kind === 'notEnabled') rec = { state: 'notEnabled', nextAt: null, at: o.at };
    else if (o.kind === 'unavailable' || o.kind === 'loginRequired') rec = { state: 'unknown', nextAt: null, at: o.at };
  }
  return rec;
}

/** The state the record means now. Only a "used" record past its date is promoted to "available"; the rest move toward saying less. */
function effective(rec, now = Date.now()) {
  if (!rec) return { state: 'unknown', nextAt: null };
  if (rec.state === 'used') {
    if (rec.nextAt) return now >= rec.nextAt ? { state: 'available', nextAt: null } : { state: 'used', nextAt: rec.nextAt };
    return now - rec.at > STALE_MS ? { state: 'unknown', nextAt: null } : { state: 'used', nextAt: null };
  }
  if (rec.state === 'notEnabled') return now - rec.at > STALE_MS ? { state: 'unknown', nextAt: null } : { state: 'notEnabled', nextAt: null };
  return { state: rec.state, nextAt: null };
}

/** Which limit a limit-notice sentence refers to. Uses the same words as Tally. */
function capScope(text) {
  const t = text.toLowerCase();
  if (t.includes('session limit') || t.includes('5-hour limit')) return 'session';
  if (t.includes('weekly limit')) return 'weekly';
  return 'model';
}

/**
 * Trailing lines of a session transcript -> the limit currently in effect ('session'|'weekly'|'model') or null.
 * Scans from the end. If a normal response or a successful reset comes after the limit notice, the limit counts as lifted.
 */
function wallOf(lines, now = Date.now()) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || (!line.includes('"assistant"') && !line.includes('"local_command"'))) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    if (o.type === 'system' && o.subtype === 'local_command') {
      const s = typeof o.content === 'string' ? signalInText(o.content, now) : null;
      if (s && s.kind === 'reset') return null;
      continue;
    }
    if (o.type !== 'assistant') continue;
    if (o.isApiErrorMessage !== true) return null;
    const text = productTexts(o).join(' ');
    if (!/limit/i.test(text)) return null;
    const resetsAt = parseStamp('resets ', plain(text), Date.parse(o.timestamp) || now);
    if (resetsAt && resetsAt <= now) return null; // The announced time has passed, so the limit lifted on its own.
    return capScope(text);
  }
  return null;
}

/** Project folder name used by Claude Code: every character other than letters and digits becomes '-'. */
function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

module.exports = {
  COMMAND,
  STALE_MS,
  parseStamp,
  signalInText,
  signalInLine,
  worthParsing,
  fold,
  effective,
  capScope,
  wallOf,
  projectSlug,
};

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const sources = createRequire(import.meta.url)('../lib/sources.js');
const { shQuote, sessionName } = sources;

describe('shell quoting', () => {
  it('makes one shell word out of a path with spaces and quotes', () => {
    const p = "/Users/Jo O'Neil/.local/bin/claude";
    expect(shQuote(p)).toBe("'/Users/Jo O'\\''Neil/.local/bin/claude'");
    expect(execFileSync('/bin/sh', ['-c', `printf %s ${shQuote(p)}`]).toString()).toBe(p);
  });
});

describe('session names from session files', () => {
  it('keeps a real name exactly, spaces and all', () => {
    expect(sessionName('my project')).toBe('my project');
    expect(sessionName('작업-1')).toBe('작업-1');
  });

  it('refuses empty names, control characters, and non-strings', () => {
    expect(sessionName('')).toBe('');
    expect(sessionName('a\nb')).toBe('');
    expect(sessionName(42)).toBe('');
  });
});

describe('reading Tally for the first-run screen', () => {
  const { readTally, tallyResult } = sources;
  const ran = (over) => ({ ok: true, code: 0, killed: false, message: '', stdout: '', stderr: '', ...over });
  const saved = process.env.TALLY_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.TALLY_BIN;
    else process.env.TALLY_BIN = saved;
  });

  it('calls a tally CLI that is not there "missing"', async () => {
    process.env.TALLY_BIN = '/nonexistent/tally';
    expect(await readTally()).toEqual({ status: null, problem: { kind: 'missing' } });
  });

  it('calls a tally CLI that exits with an error "failed", with the command and the exit code', async () => {
    process.env.TALLY_BIN = '/usr/bin/false';
    expect(await readTally()).toEqual({
      status: null,
      problem: { kind: 'failed', command: '/usr/bin/false status --json', detail: 'exited with code 1' },
    });
  });

  it('keeps the first 200 characters of stderr, on one line', () => {
    const r = tallyResult('tally', ran({ ok: false, code: 2, stderr: `Tally is not running.\n${'x'.repeat(300)}` }));
    expect(r.problem.kind).toBe('failed');
    expect(r.problem.detail).toHaveLength(200);
    expect(r.problem.detail.startsWith('Tally is not running. xxx')).toBe(true);
  });

  it('passes on Node\'s message for a file it may not run', async () => {
    process.env.TALLY_BIN = '/etc/hosts';
    const r = await readTally();
    expect(r.problem).toMatchObject({ kind: 'failed', command: '/etc/hosts status --json' });
    expect(r.problem.detail).toMatch(/EACCES/);
  });

  it('says so when tally does not answer in time', () => {
    expect(tallyResult('tally', ran({ ok: false, code: null, killed: true })).problem.detail).toBe('no answer within 8 seconds');
  });

  it('calls output that is not JSON, or JSON without accounts, "failed"', () => {
    expect(tallyResult('tally', ran({ stdout: '<html>oops' })).problem.detail).toBe('printed something that is not JSON: <html>oops');
    expect(tallyResult('tally', ran({ stdout: '' })).problem.detail).toBe('printed something that is not JSON: (nothing)');
    expect(tallyResult('tally', ran({ stdout: '{"version":1}' })).problem.detail).toBe('the JSON has no accounts list');
  });

  it('passes a good status through with no problem', () => {
    expect(tallyResult('tally', ran({ stdout: '{"accounts":[]}' }))).toEqual({ status: { accounts: [] }, problem: null });
  });
});

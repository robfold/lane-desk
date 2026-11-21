import { describe, it, expect } from 'vitest';
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

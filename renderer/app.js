'use strict';
/* global desk */

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'window' ? 'window' : 'popover';
let tab = params.get('tab') === 'sessions' ? 'sessions' : 'usage';
let view = null;
let busy = new Set(); // keys of buttons at work; stops double clicks and jumping buttons

// Strings come with each view from the main process. Before the first view, only the loading line is needed.
const BOOT = /^ko\b/i.test(navigator.language) ? { 'ui.loading': 'Tally 상태를 읽는 중…' } : { 'ui.loading': 'Reading Tally status…' };
function T(key, vars) {
  const table = (view && view.strings) || BOOT;
  const s = table[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k]))) : s;
}

/** Text in index.html: data-t sets the text, data-t-title the tooltip. */
function applyStatic() {
  if (!view || !view.strings) return;
  document.documentElement.lang = view.lang || 'en';
  for (const el of document.querySelectorAll('[data-t]')) el.firstChild.nodeValue = T(el.dataset.t) + (el.children.length ? ' ' : '');
  for (const el of document.querySelectorAll('[data-t-title]')) el.title = T(el.dataset.tTitle);
}

document.body.classList.add(`mode-${mode}`);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
function ring(pct) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const v = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : 0;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'ring');
  for (const [cls, dash] of [['track', `${c} ${c}`], [`fill ${tone(pct)}`, `${(c * v) / 100} ${c}`]]) {
    const el = document.createElementNS(SVG, 'circle');
    el.setAttribute('cx', '32');
    el.setAttribute('cy', '32');
    el.setAttribute('r', String(r));
    el.setAttribute('class', cls);
    el.setAttribute('stroke-dasharray', dash);
    svg.append(el);
  }
  const wrap = h('div', { class: 'ring-wrap' }, svg, h('div', { class: 'ring-label' }, h('b', {}, pct ?? '–'), h('small', {}, T('ui.left'))));
  return wrap;
}

function tone(pct) {
  if (typeof pct !== 'number') return 'none';
  if (pct <= 0) return 'out';
  if (pct < 25) return 'low';
  return 'ok';
}

function meter(label, m) {
  if (!m || typeof m.remaining !== 'number') return h('div', { class: 'meter empty' });
  const fill = h('div', { class: 'meter-fill' });
  fill.style.width = `${Math.max(0, Math.min(100, m.remaining))}%`; // CSSOM, not a style attribute, because of the CSP
  return h(
    'div',
    { class: `meter ${tone(m.remaining)}` },
    h('div', { class: 'meter-head' }, h('span', { class: 'meter-label' }, label), h('b', {}, m.remaining <= 0 ? T('ui.out') : `${m.remaining}%`), h('span', { class: 'muted' }, m.left || '')),
    h('div', { class: 'meter-track' }, fill),
  );
}

async function act(key, fn) {
  if (busy.has(key)) return;
  busy.add(key);
  render();
  try {
    const r = await fn();
    toast(r && r.message ? r.message : T('ui.done'), r && r.ok === false);
  } catch (e) {
    toast(T('ui.failedPrefix', { msg: e.message }), true);
  } finally {
    busy.delete(key);
    render();
  }
}

/** A custom lane shows its command; the default lane shows the account folder it points the CLI at. */
function laneText(a) {
  return a.lane === a.provider && a.laneHome ? a.laneHome : a.lane;
}
function laneTitle(a) {
  return a.lane === a.provider ? `${a.provider} · ${a.laneHome || ''}` : `${a.lane} · ${a.laneHome || ''}`;
}

/** New session: off without a command or without tmux; quieter (still allowed) when the weekly limit is used up. */
function newSessionButton(a) {
  const key = `new:${a.id}`;
  const working = busy.has(key);
  const noTmux = view.tmux === false;
  let title = T('ui.newSession.title', { lane: laneText(a) });
  if (!a.lane) title = T('ui.noLane.title');
  else if (noTmux) title = T('ui.needTmux');
  else if (a.outNote) title = a.outNote;
  return h(
    'button',
    {
      class: `go${a.outNote ? ' quiet' : ''}${working ? ' working' : ''}`,
      disabled: !a.lane || noTmux || working,
      title,
      onclick: () => act(key, () => desk.newSession(a.id)),
    },
    working ? T('ui.opening') : T('ui.newSession'),
  );
}

function accountRow(a, provider) {
  return h(
    'div',
    { class: `acct${a.exhausted ? ' exhausted' : ''}${a.best ? ' best' : ''}${a.runout && a.runout.state === 'before' ? ' runout' : ''}` },
    // Name, tags, and the button stay together: one grid row in a wide card, their own row above the bars in a narrow one.
    h(
      'div',
      { class: 'acct-head' },
      h(
        'div',
        { class: 'acct-id' },
        h('div', { class: 'acct-label', title: a.label }, a.label),
        h(
          'div',
          { class: 'acct-tags' },
          a.lane ? h('code', { class: 'entry', title: laneTitle(a) }, laneText(a)) : h('span', { class: 'muted' }, T('ui.noLane')),
          a.best ? h('span', { class: 'tag best' }, T('ui.best')) : null,
          a.live ? h('span', { class: 'tag live', title: T('ui.live') }, `● ${a.live}`) : null,
          a.stale || a.failed ? h('span', { class: 'tag warn' }, a.failed ? T('ui.failed') : T('ui.stale')) : null,
          a.limitReset && a.limitReset.label ? h('span', { class: `tag reset ${a.limitReset.state}`, title: a.limitReset.title }, a.limitReset.label) : null,
          a.codexResets ? h('span', { class: 'tag reset available', title: a.codexResets.title }, a.codexResets.label) : null,
          a.runout && a.runout.label ? h('span', { class: `tag runout ${a.runout.state}`, title: a.runout.title }, a.runout.label) : null,
        ),
      ),
      newSessionButton(a),
    ),
    provider.id === 'claude' ? meter(a.model ? a.model.name : 'Model', a.model) : null,
    meter(T('ui.weekly'), a.weekly),
  );
}

function providerCard(p) {
  const verdict = p.verdict ? h('span', { class: `verdict ${p.verdict.tone}`, title: p.verdict.title }, p.verdict.label) : null;
  return h(
    'section',
    { class: `card ${p.id}` },
    h(
      'div',
      { class: 'card-head' },
      ring(p.remaining),
      h('div', { class: 'card-title' }, h('h2', {}, p.name, h('span', { class: 'muted' }, T('ui.accounts', { n: p.accounts.length }))), verdict, p.headline ? h('p', { class: 'muted small' }, p.headline) : null),
    ),
    h('div', { class: `acct-list ${p.id}` }, p.accounts.map((a) => accountRow(a, p))),
  );
}

function usageTab() {
  // Without tmux every New session button is off; say why where it can be seen, not only on hover.
  const noTmux = view.tmux === false ? h('p', { class: 'notice' }, T('ui.needTmux.notice'), ' ', h('code', {}, 'brew install tmux')) : null;
  return h('div', {}, noTmux, h('div', { class: 'providers' }, view.providers.map(providerCard)));
}

// The status values in Claude session files. "shell" looks like a shell command is running (observed, not documented).
const STATUS_KEY = { busy: 'ui.status.busy', idle: 'ui.status.idle', shell: 'ui.status.shell', waiting: 'ui.status.waiting' };

function resetButton(s) {
  if (!s.reset) return null;
  const key = `reset:${s.pid}`;
  const working = busy.has(key);
  return h(
    'button',
    {
      class: `go reset${working ? ' working' : ''}`,
      disabled: !s.reset.can || working,
      title: s.reset.can ? T('ui.reset.title') : s.reset.why,
      onclick: () => act(key, () => desk.limitReset(s.pid)),
    },
    working ? T('ui.resetting') : T('ui.reset'),
  );
}

function sessionsTab() {
  if (!view.sessions.length) return h('p', { class: 'empty-state' }, T('ui.noSessions'));
  return h(
    'div',
    { class: 'sessions' },
    view.sessions.map((s) => {
      const key = `attach:${s.pid}`;
      const working = busy.has(key);
      return h(
        'div',
        { class: `sess ${s.status}` },
        h('span', { class: 'dot', title: s.status }),
        h(
          'div',
          { class: 'sess-main' },
          h('div', { class: 'sess-name' }, s.name),
          h('div', { class: 'muted small' }, s.account, s.lane && s.lane !== 'claude' ? h('code', { class: 'entry' }, s.lane) : null, ' · ', s.cwd),
        ),
        h(
          'div',
          { class: 'sess-meta muted small' },
          s.wallLabel ? h('span', { class: 'tag wall' }, s.wallLabel) : STATUS_KEY[s.status] ? T(STATUS_KEY[s.status]) : s.status,
          h('br'),
          s.ago || '',
        ),
        h(
          'div',
          { class: 'sess-actions' },
          resetButton(s),
          h(
            'button',
          {
            class: `go${working ? ' working' : ''}`,
            disabled: !s.tmux || working,
            title: s.tmux ? T('ui.attach.title', { name: s.tmux }) : T('ui.notTmux.title'),
            onclick: () => act(key, () => desk.attach(s.pid)),
          },
            working ? T('ui.attaching') : s.tmux ? T('ui.attach') : T('ui.notTmux'),
          ),
        ),
      );
    }),
  );
}

/** First run: Tally is missing (what it is, where to get it, the demo), has no accounts, or ran and failed (what went wrong). */
function setupScreen(s) {
  const demo = () => [
    h('p', { class: 'muted small' }, T('setup.missing.demo')),
    h(
      'div',
      { class: 'cmd copy' },
      h('code', {}, s.demoCommand),
      h('button', { class: 'go', onclick: () => act('copy', () => desk.copyDemo()) }, T('setup.copy')),
    ),
  ];
  if (s.kind === 'missing') {
    return h(
      'section',
      { class: 'setup' },
      h('h2', {}, T('setup.missing.title')),
      h('p', {}, T('setup.missing.what')),
      // target=_blank goes to the window-open handler in main.js, which opens https links in the default browser.
      h('a', { class: 'link', href: s.tallyUrl, target: '_blank', rel: 'noopener', title: s.tallyUrl }, `${T('setup.missing.get')} ↗`),
      h('p', { class: 'muted' }, T('setup.missing.after')),
      demo(),
    );
  }
  if (s.kind === 'noAccounts') {
    return h('section', { class: 'setup' }, h('h2', {}, T('setup.noAccounts.title')), h('p', {}, T('setup.noAccounts.after')), demo());
  }
  return h(
    'section',
    { class: 'setup failed' },
    h('h2', {}, T('setup.failed.title')),
    s.command ? h('div', { class: 'cmd' }, h('code', {}, s.command)) : null,
    h('p', { class: 'detail' }, s.detail),
    h('p', { class: 'muted' }, T('setup.failed.after')),
  );
}

function render() {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const content = document.getElementById('content');
  const count = document.getElementById('session-count');
  applyStatic();
  if (!view || view.loading) {
    content.replaceChildren(h('p', { class: 'empty-state' }, T('ui.loading')));
    return;
  }
  count.textContent = view.sessions && view.sessions.length ? String(view.sessions.length) : '';
  if (view.setup) {
    content.replaceChildren(setupScreen(view.setup));
    updatedLabel();
    return;
  }
  if (view.error) {
    content.replaceChildren(h('p', { class: 'empty-state error' }, view.error));
    return;
  }
  content.replaceChildren(tab === 'usage' ? usageTab() : sessionsTab());
  updatedLabel();
}

function updatedLabel() {
  const el = document.getElementById('updated');
  if (!view || !view.fetchedAt) return;
  const s = Math.round((Date.now() - view.fetchedAt) / 1000);
  // The popover's top bar has room for a short word only ("Just now", not "Updated just now").
  const now = mode === 'popover' ? T('ui.justUpdated.short') : T('ui.justUpdated');
  el.textContent = s < 5 ? now : s < 60 ? T('ui.secAgo', { n: s }) : T('ui.minAgo', { n: Math.floor(s / 60) });
  el.classList.toggle('warn', Boolean(view.stale));
  el.title = view.stale ? T('ui.staleTitle') : '';
}

let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 4500);
}

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    render();
  });
}
document.getElementById('refresh').addEventListener('click', () => act('refresh', async () => ({ ok: true, message: (await desk.refresh(), T('ui.reloaded')) })));
document.getElementById('open-window').addEventListener('click', () => desk.openWindow());
document.getElementById('new-tab').addEventListener('click', () => desk.newTab());

desk.onView((v) => {
  view = v;
  render();
});
desk
  .get()
  .then((v) => {
    view = v;
    render();
  })
  .catch((e) => toast(T('ui.failedPrefix', { msg: e.message }), true));
setInterval(updatedLabel, 5000);
render();

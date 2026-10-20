import { percent, price, signed, volume } from './format.js';
import { initOptions } from './options.js';
import { replaceStream, streamUrl } from './stream.js';

const SERVICE = 'LEVELONE_EQUITIES';
const STORAGE_KEY = 'smp.watchlist';
const COLUMNS = [
  ['BID_PRICE', price],
  ['ASK_PRICE', price],
  ['LAST_PRICE', price],
  ['NET_CHANGE', signed],
  ['NET_CHANGE_PERCENT', percent],
  ['MARK', price],
  ['TOTAL_VOLUME', volume],
];

const $ = (id) => document.getElementById(id);
const rows = new Map(); // symbol -> { tr, cells: Map<field, td>, updated }
let symbols = loadSymbols();
let source = null;
let renewing = false; // showing the login steps while still logged in
let lastStatus = null;

init();

async function init() {
  $('login-form').addEventListener('submit', onLogin);
  $('add-form').addEventListener('submit', onAdd);
  $('logout').addEventListener('click', onLogout);
  $('renew').addEventListener('click', () => setRenewing(true));
  $('renew-cancel').addEventListener('click', () => setRenewing(false));
  $('example').textContent = [
    '# latest quotes (REST)',
    `curl -s '${location.origin}/api/marketdata/quotes?symbols=AAPL,MSFT'`,
    '',
    '# live stream (SSE)',
    `curl -N '${location.origin}/api/stream?service=LEVELONE_EQUITIES&keys=AAPL,MSFT'`,
    '',
    '# option expirations and one expiration of the chain',
    `curl -s '${location.origin}/api/marketdata/expirationchain?symbol=SPY'`,
    `curl -s '${location.origin}/api/marketdata/chains?symbol=SPY&fromDate=2026-11-20&toDate=2026-11-20&strikeCount=10'`,
    '',
    '# live option quotes; keys are chain "symbol" values (spaces encoded)',
    `curl -N '${location.origin}/api/stream?service=LEVELONE_OPTIONS&keys=SPY%20%20%20261120C00770000'`,
  ].join('\n');
  initOptions();
  for (const s of symbols) addRow(s);
  await refreshStatus();
  openStream();
  setInterval(refreshStatus, 15_000);
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    renderStatus(status);
  } catch {
    setPill('pill-auth', 'Auth: server unreachable', 'bad');
  }
}

function renderStatus(status) {
  lastStatus = status;
  const { auth, stream, services } = status;
  if (auth) {
    if (!auth.loggedIn) renewing = false;
    $('setup').hidden = auth.configured;
    $('login').hidden = !auth.configured || (auth.loggedIn && !renewing);
    $('login-title').textContent = renewing ? 'Renew Schwab login' : 'Log in with Schwab';
    $('renew-note').hidden = !renewing;
    $('renew-cancel').hidden = !renewing;
    $('renew').hidden = !auth.loggedIn || renewing;
    $('logout').hidden = !auth.loggedIn;
    $('callback-url').textContent = auth.callbackUrl;
    if (!auth.configured) setPill('pill-auth', 'Auth: not configured', 'bad');
    else if (!auth.loggedIn) setPill('pill-auth', 'Auth: logged out', 'warn');
    else setPill('pill-auth', `Auth: OK · re-login by ${formatDate(auth.refreshExpiresAt)}`, 'ok');
  }
  if (services) $('services').textContent = services.join(', ');
  if (stream) renderStream(stream);
}

function renderStream(stream) {
  const tone = { ready: 'ok', connecting: 'warn', reconnecting: 'warn', waiting_for_login: 'warn' }[stream.state] ?? '';
  setPill('pill-stream', `Stream: ${stream.state.replaceAll('_', ' ')}`, tone);
  $('stream-error').textContent = stream.lastError ?? '';
}

function openStream() {
  const previous = source;
  if (symbols.length === 0) {
    previous?.close();
    source = null;
    return;
  }
  source = replaceStream(previous, streamUrl(SERVICE, symbols), {
    onData: renderQuote,
    onStatus: renderStream,
    onClosed: () => setPill('pill-stream', 'Stream: closed', 'bad'),
  });
}

function renderQuote({ key, fields, changed }) {
  const row = rows.get(key);
  if (!row) return;
  const changedSet = new Set(changed);
  for (const [field, fmt] of COLUMNS) {
    const td = row.cells.get(field);
    const value = fields[field];
    if (value === undefined) continue;
    const before = td.dataset.raw;
    td.textContent = fmt(value);
    td.dataset.raw = String(value);
    if (changedSet.has(field) && before !== undefined && typeof value === 'number') {
      flash(td, value > Number(before) ? 'up' : value < Number(before) ? 'down' : null);
    }
    if (field === 'NET_CHANGE' || field === 'NET_CHANGE_PERCENT') {
      td.classList.toggle('pos', value > 0);
      td.classList.toggle('neg', value < 0);
    }
  }
  const t = fields.QUOTE_TIME_MILLIS ?? fields.TRADE_TIME_MILLIS;
  if (t) row.updated.textContent = new Date(t).toLocaleTimeString();
}

function addRow(symbol) {
  if (rows.has(symbol)) return;
  const tr = document.createElement('tr');
  const name = document.createElement('th');
  name.scope = 'row';
  name.textContent = symbol;
  tr.append(name);
  const cells = new Map();
  for (const [field] of COLUMNS) {
    const td = document.createElement('td');
    td.className = 'num';
    td.textContent = '—';
    cells.set(field, td);
    tr.append(td);
  }
  const updated = document.createElement('td');
  updated.className = 'num muted';
  tr.append(updated);
  const actions = document.createElement('td');
  const remove = document.createElement('button');
  remove.className = 'ghost small';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', `Remove ${symbol}`);
  remove.addEventListener('click', () => removeSymbol(symbol));
  actions.append(remove);
  tr.append(actions);
  document.querySelector('#quotes tbody').append(tr);
  rows.set(symbol, { tr, cells, updated });
  $('empty').hidden = true;
}

function removeSymbol(symbol) {
  rows.get(symbol)?.tr.remove();
  rows.delete(symbol);
  symbols = symbols.filter((s) => s !== symbol);
  saveSymbols();
  $('empty').hidden = symbols.length > 0;
  openStream();
}

function onAdd(ev) {
  ev.preventDefault();
  const input = $('add-symbols');
  const fresh = input.value
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && !symbols.includes(s));
  if (fresh.length === 0) return;
  symbols = [...symbols, ...fresh];
  fresh.forEach(addRow);
  saveSymbols();
  input.value = '';
  openStream();
}

async function onLogin(ev) {
  ev.preventDefault();
  $('login-error').textContent = '';
  const res = await fetch('/api/auth/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirectUrl: $('redirect-url').value }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('login-error').textContent = body?.error?.message ?? `Login failed (HTTP ${res.status})`;
    return;
  }
  $('redirect-url').value = '';
  renewing = false;
  await refreshStatus();
}

function setRenewing(on) {
  renewing = on;
  $('login-error').textContent = '';
  if (lastStatus) renderStatus(lastStatus);
  if (on) $('login').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function onLogout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await refreshStatus();
}

function setPill(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${tone ?? ''}`.trim();
}

function flash(td, dir) {
  if (!dir) return;
  td.classList.remove('flash-up', 'flash-down');
  void td.offsetWidth; // restart the animation
  td.classList.add(dir === 'up' ? 'flash-up' : 'flash-down');
}

function loadSymbols() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveSymbols() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
  } catch {
    /* storage unavailable; the list just won't persist */
  }
}

function formatDate(ms) {
  return ms ? new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '?';
}

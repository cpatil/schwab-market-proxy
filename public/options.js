import { greek, iv, premium, price, signed, percent, volume } from './format.js';
import { getJson, replaceStream, streamUrl } from './stream.js';

const STORAGE_KEY = 'smp.options';
// [chain JSON field, LEVELONE_OPTIONS stream field, header, formatter]; puts show these mirrored.
const SIDE_COLUMNS = [
  ['bid', 'BID_PRICE', 'Bid', premium],
  ['ask', 'ASK_PRICE', 'Ask', premium],
  ['last', 'LAST_PRICE', 'Last', premium],
  ['totalVolume', 'TOTAL_VOLUME', 'Vol', volume],
  ['openInterest', 'OPEN_INTEREST', 'OI', volume],
  ['volatility', 'VOLATILITY', 'IV', iv],
  ['delta', 'DELTA', 'Δ', greek],
];

const $ = (id) => document.getElementById(id);
const state = { symbol: null, underlyingPrice: null, rows: [], bySymbol: new Map(), source: null };

export function initOptions() {
  buildHeader();
  const saved = loadSaved();
  if (saved.symbol) $('opt-symbol').value = saved.symbol;
  if (saved.strikes) $('opt-strikes').value = saved.strikes;
  $('opt-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    loadUnderlying();
  });
  $('opt-exp').addEventListener('change', loadChain);
  $('opt-strikes').addEventListener('change', loadChain);
  if (saved.symbol) loadUnderlying(saved.expiration);
}

async function loadUnderlying(preferredExpiration) {
  const symbol = $('opt-symbol').value.trim().toUpperCase();
  if (!symbol) return;
  setError('');
  const select = $('opt-exp');
  select.disabled = true;
  try {
    const { expirationList = [] } = await getJson(`/api/marketdata/expirationchain?symbol=${encodeURIComponent(symbol)}`);
    if (expirationList.length === 0) throw new Error(`No option expirations for ${symbol}`);
    select.replaceChildren(...expirationList.map((e) => {
      const opt = document.createElement('option');
      opt.value = e.expirationDate;
      opt.textContent = `${shortDate(e.expirationDate)} (${e.daysToExpiration}d${e.expirationType && e.expirationType !== 'S' ? ` ${e.expirationType}` : ''})`;
      return opt;
    }));
    const keep = expirationList.find((e) => e.expirationDate === preferredExpiration);
    const firstLive = expirationList.find((e) => e.daysToExpiration > 0) ?? expirationList[0];
    select.value = (keep ?? firstLive).expirationDate;
    select.disabled = false;
    state.symbol = symbol;
    await loadChain();
  } catch (err) {
    setError(err.message);
  }
}

async function loadChain() {
  const symbol = state.symbol;
  const expiration = $('opt-exp').value;
  const strikes = $('opt-strikes').value;
  if (!symbol || !expiration) return;
  save({ symbol, expiration, strikes });
  setError('');
  const q = new URLSearchParams({
    symbol,
    strikeCount: strikes,
    fromDate: expiration,
    toDate: expiration,
    includeUnderlyingQuote: 'true',
  });
  try {
    const chain = await getJson(`/api/marketdata/chains?${q}`);
    if (chain.status && chain.status !== 'SUCCESS') throw new Error(`Schwab returned status ${chain.status} for ${symbol}`);
    renderChain(chain);
    openStream();
  } catch (err) {
    setError(err.message);
  }
}

function renderChain(chain) {
  const byStrike = new Map();
  for (const [side, map] of [['call', chain.callExpDateMap], ['put', chain.putExpDateMap]]) {
    for (const strikes of Object.values(map ?? {})) {
      for (const contracts of Object.values(strikes)) {
        const c = contracts[0];
        if (!c) continue;
        const row = byStrike.get(c.strikePrice) ?? { strike: c.strikePrice };
        row[side] = c;
        byStrike.set(c.strikePrice, row);
      }
    }
  }
  state.underlyingPrice = chain.underlyingPrice ?? chain.underlying?.last ?? null;
  state.bySymbol.clear();
  state.rows = [...byStrike.values()].sort((a, b) => a.strike - b.strike).map(buildRow);
  $('chain').querySelector('tbody').replaceChildren(...state.rows.map((r) => r.tr));
  renderSummary(chain);
  shadeMoneyness();
}

function buildRow({ strike, call, put }) {
  const tr = document.createElement('tr');
  const sides = {};
  const callCells = SIDE_COLUMNS.map(() => cell());
  const putCells = SIDE_COLUMNS.map(() => cell());
  const strikeCell = document.createElement('th');
  strikeCell.scope = 'row';
  strikeCell.className = 'strike num';
  strikeCell.textContent = premium(strike);
  tr.append(...callCells, strikeCell, ...[...putCells].reverse());
  for (const [side, contract, cells] of [['call', call, callCells], ['put', put, putCells]]) {
    if (!contract) continue;
    const entry = { strike, side, cells, values: {} };
    SIDE_COLUMNS.forEach(([chainField, , , fmt], i) => setCell(entry, i, contract[chainField], fmt, false));
    sides[side] = entry;
    state.bySymbol.set(contract.symbol, entry);
    cells.forEach((td) => (td.title = contract.description ?? contract.symbol));
  }
  return { strike, tr, strikeCell, sides, callCells, putCells };
}

function openStream() {
  const keys = [...state.bySymbol.keys()];
  if (keys.length === 0) return;
  state.source = replaceStream(state.source, streamUrl('LEVELONE_OPTIONS', keys), {
    onData: onQuote,
    onClosed: () => setError('Option stream closed; reload the chain.'),
  });
}

function onQuote({ key, fields, changed }) {
  const entry = state.bySymbol.get(key);
  if (!entry) return;
  const changedSet = new Set(changed);
  SIDE_COLUMNS.forEach(([, streamField, , fmt], i) => {
    if (changedSet.has(streamField) && fields[streamField] !== undefined) setCell(entry, i, fields[streamField], fmt, true);
  });
  if (typeof fields.UNDERLYING_PRICE === 'number' && fields.UNDERLYING_PRICE !== state.underlyingPrice) {
    state.underlyingPrice = fields.UNDERLYING_PRICE;
    $('opt-underlying-price').textContent = price(state.underlyingPrice);
    shadeMoneyness();
  }
}

function setCell(entry, i, value, fmt, live) {
  const td = entry.cells[i];
  const before = entry.values[i];
  entry.values[i] = value;
  td.textContent = fmt(value);
  if (live && typeof value === 'number' && typeof before === 'number' && value !== before) {
    td.classList.remove('flash-up', 'flash-down');
    void td.offsetWidth;
    td.classList.add(value > before ? 'flash-up' : 'flash-down');
  }
}

/** Shade in-the-money cells and mark the strike nearest the underlying. */
function shadeMoneyness() {
  const u = state.underlyingPrice;
  let atm = null;
  for (const row of state.rows) {
    row.callCells.forEach((td) => td.classList.toggle('itm', u != null && row.strike < u));
    row.putCells.forEach((td) => td.classList.toggle('itm', u != null && row.strike > u));
    if (u != null && (atm == null || Math.abs(row.strike - u) < Math.abs(atm.strike - u))) atm = row;
    row.strikeCell.classList.remove('atm');
  }
  atm?.strikeCell.classList.add('atm');
}

function renderSummary(chain) {
  const u = chain.underlying ?? {};
  const summary = $('opt-summary');
  summary.replaceChildren();
  const name = document.createElement('strong');
  name.textContent = chain.symbol;
  const last = document.createElement('span');
  last.id = 'opt-underlying-price';
  last.className = 'num';
  last.textContent = price(state.underlyingPrice);
  const change = document.createElement('span');
  change.className = `num ${u.change > 0 ? 'pos' : u.change < 0 ? 'neg' : ''}`;
  change.textContent = u.change != null ? `${signed(u.change)} (${percent(u.percentChange)})` : '';
  const meta = document.createElement('span');
  meta.className = 'muted';
  const contracts = state.bySymbol.size;
  meta.textContent = `${contracts} contracts · ${chain.isDelayed ? 'delayed' : 'real-time'} · shaded = in the money`;
  summary.append(name, ' ', last, ' ', change, ' · ', meta);
}

function buildHeader() {
  const thead = $('chain').querySelector('thead');
  const sides = document.createElement('tr');
  sides.className = 'sides';
  const calls = document.createElement('th');
  calls.colSpan = SIDE_COLUMNS.length;
  calls.textContent = 'Calls';
  const puts = document.createElement('th');
  puts.colSpan = SIDE_COLUMNS.length;
  puts.textContent = 'Puts';
  puts.className = 'right';
  sides.append(calls, document.createElement('th'), puts);
  const cols = document.createElement('tr');
  const head = (text) => {
    const th = document.createElement('th');
    th.className = 'num';
    th.textContent = text;
    return th;
  };
  const strike = head('Strike');
  strike.classList.add('strike');
  cols.append(...SIDE_COLUMNS.map((c) => head(c[2])), strike, ...[...SIDE_COLUMNS].reverse().map((c) => head(c[2])));
  thead.replaceChildren(sides, cols);
}

function cell() {
  const td = document.createElement('td');
  td.className = 'num';
  td.textContent = '—';
  return td;
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
}

function setError(msg) {
  $('opt-error').textContent = msg;
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function save(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

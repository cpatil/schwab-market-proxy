const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function price(v) {
  return isNum(v) ? v.toFixed(Math.abs(v) < 1 ? 4 : 2) : v == null ? '—' : String(v);
}
export function signed(v) {
  return isNum(v) ? `${v > 0 ? '+' : ''}${price(v)}` : price(v);
}
export function percent(v) {
  return isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : price(v);
}
export function volume(v) {
  return isNum(v) ? v.toLocaleString() : price(v);
}
/** Implied volatility; Schwab reports it already in percent (14.49 = 14.49%). */
export function iv(v) {
  return isNum(v) ? `${v.toFixed(1)}%` : price(v);
}
export function greek(v) {
  return isNum(v) ? v.toFixed(3) : price(v);
}
/** Option premiums and strikes trade in cents, so always two decimals. */
export function premium(v) {
  return isNum(v) ? v.toFixed(2) : price(v);
}

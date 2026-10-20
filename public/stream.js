/**
 * Opens a proxy SSE stream and closes `previous` only once the new one is
 * subscribed, so keys both streams share never drop to zero subscribers
 * (which would make the proxy unsubscribe and resubscribe upstream).
 */
export function replaceStream(previous, url, { onData, onStatus, onClosed } = {}) {
  const next = new EventSource(url);
  next.addEventListener('status', (ev) => {
    previous?.close();
    onStatus?.(JSON.parse(ev.data));
  });
  next.addEventListener('data', (ev) => onData?.(JSON.parse(ev.data)));
  next.addEventListener('error', () => {
    if (next.readyState === EventSource.CLOSED) onClosed?.();
  });
  return next;
}

export function streamUrl(service, keys) {
  return `/api/stream?service=${service}&keys=${encodeURIComponent(keys.join(','))}`;
}

/** GET JSON from the proxy; throws an Error carrying the proxy's or Schwab's message. */
export async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.errors?.[0]?.detail ?? body?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

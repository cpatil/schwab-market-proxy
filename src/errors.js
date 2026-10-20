/** An error the HTTP layer can turn into a status code and a stable `code`. */
export class ProxyError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notConfigured = () =>
  new ProxyError('not_configured', 503, 'Set SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET in .env, then restart.');
export const notLoggedIn = () =>
  new ProxyError('not_logged_in', 401, 'Not logged in to Schwab. Open the dashboard and log in.');
export const badRequest = (message, details) => new ProxyError('bad_request', 400, message, details);

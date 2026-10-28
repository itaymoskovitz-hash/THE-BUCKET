// Keeps an invitation token across sign-up / email confirmation, then hands it to the server.
// The token is only a pointer; the server checks email, expiry, single use and revocation.
const KEY = 'bucket.pendingInvite';
const TTL = 1000 * 60 * 60 * 24 * 7;

export const extractToken = (text) => (String(text || '').match(/[0-9a-f]{64}/i)?.[0] || '').toLowerCase();

export function savePendingInvite(token) {
  try { localStorage.setItem(KEY, JSON.stringify({ token, at: Date.now() })); } catch { /* ignore */ }
}
export function takePendingInvite() {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    const v = raw && JSON.parse(raw);
    return v && Date.now() - v.at < TTL ? v.token : null;
  } catch { return null; }
}
export function hasPendingInvite() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}
export const inviteLink = (token) => `${location.origin}${location.pathname}#/invite/${token}`;

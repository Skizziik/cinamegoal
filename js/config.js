export const CONFIG = {
  owner: 'Skizziik',
  repo: 'cinamegoal',
  label: 'cinemagoal',
  pollMs: 10000,
  // Unauthenticated GitHub API allows 60 requests/hour per IP, so view-only polls slowly.
  readOnlyPollMs: 90000,
};

const TOKEN_KEY = 'cg_token';

// The access key never lives in the repo: it arrives once via an invite link
// (…/#key=XXXX) or is pasted in the app, and is kept in this browser only.
export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

export function takeTokenFromHash() {
  const m = /(?:^|[#&])key=([^&]+)/.exec(location.hash);
  if (!m) return false;
  setToken(decodeURIComponent(m[1]).trim());
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

export function getPollMs(readOnly) {
  try {
    const v = Number(localStorage.getItem('cg_poll'));
    if (v >= 200) return v;
  } catch { /* storage unavailable */ }
  return readOnly ? CONFIG.readOnlyPollMs : CONFIG.pollMs;
}

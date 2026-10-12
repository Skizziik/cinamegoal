// Data layer: each movie is a GitHub issue in the repo (label "cinemagoal").
// The issue body keeps a human-readable summary plus a hidden JSON block.

export const PEOPLE = {
  maksim: { name: 'Максим', short: 'М' },
  alina: { name: 'Алина', short: 'А' },
};
export const PERSON_IDS = Object.keys(PEOPLE);

const START = '<!-- cinemagoal:data';
const END = '-->';
const DATA_KEYS = ['title', 'original', 'year', 'poster', 'note', 'addedBy', 'addedAt',
  'watched', 'watchedAt', 'ratings', 'reviews'];

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function emptyMovie(fields = {}) {
  return deepMerge({
    v: 1,
    title: '',
    original: '',
    year: '',
    poster: '',
    note: '',
    addedBy: 'maksim',
    addedAt: new Date().toISOString(),
    watched: false,
    watchedAt: null,
    ratings: { maksim: null, alina: null },
    reviews: { maksim: '', alina: '' },
  }, fields);
}

export function toData(movie) {
  const out = { v: 1 };
  for (const k of DATA_KEYS) out[k] = movie[k];
  return out;
}

export function averageRating(movie) {
  const vals = PERSON_IDS.map((p) => movie.ratings?.[p]).filter((r) => Number.isFinite(r));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

export function clampRating(r) {
  if (r === null || r === undefined || r === '') return null;
  const n = Math.round(Number(r));
  if (!Number.isFinite(n)) return null;
  return Math.min(10, Math.max(1, n));
}

export function normalizeTitle(t) {
  return String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

export function serializeBody(movie) {
  const m = toData(movie);
  const who = PEOPLE[m.addedBy]?.name || m.addedBy;
  const lines = [`🎬 **${m.title}**${m.year ? ` (${m.year})` : ''}`, '', `Добавил(а): ${who}`];
  lines.push(`Статус: ${m.watched ? '✅ просмотрен' : '⏳ хотим посмотреть'}`);
  const rated = PERSON_IDS.filter((p) => m.ratings?.[p]);
  if (rated.length) lines.push(`Оценки: ${rated.map((p) => `${PEOPLE[p].name} ${m.ratings[p]}/10`).join(' · ')}`);
  // Escape < and > so user text can never terminate the HTML comment early.
  const json = JSON.stringify(m).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${lines.join('\n')}\n\n${START}\n${json}\n${END}\n`;
}

export function parseIssue(issue) {
  if (!issue || issue.pull_request) return null;
  const body = issue.body || '';
  let data = {};
  const start = body.lastIndexOf(START);
  if (start !== -1) {
    const end = body.indexOf(END, start + START.length);
    try {
      data = JSON.parse(body.slice(start + START.length, end === -1 ? undefined : end));
    } catch {
      data = {};
    }
  }
  const movie = emptyMovie({ title: issue.title, addedAt: issue.created_at, ...data });
  if (!movie.title) movie.title = issue.title;
  movie.ratings = { maksim: clampRating(movie.ratings.maksim), alina: clampRating(movie.ratings.alina) };
  movie.id = issue.number;
  movie.deleted = issue.state === 'closed';
  movie.updatedAt = issue.updated_at;
  return movie;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Flattens a patch into [path, value] leaves: {ratings:{alina:9}} → [[['ratings','alina'], 9]]
export function leafPaths(patch, prefix = []) {
  if (!isPlainObject(patch)) return [[prefix, patch]];
  return Object.entries(patch).filter(([, v]) => v !== undefined).flatMap(([k, v]) => leafPaths(v, [...prefix, k]));
}

export function buildPatch(leaves) {
  const out = {};
  for (const [path, value] of leaves) {
    let o = out;
    path.slice(0, -1).forEach((k) => { o = o[k] ??= {}; });
    o[path[path.length - 1]] = value;
  }
  return out;
}

// Fields of our patch that someone else's concurrent write reverted to the old value.
export function lostLeaves(leaves, before, now) {
  return leaves.filter(([p, v]) => !same(getPath(now, p), v) && same(getPath(now, p), getPath(before, p)));
}

function nextLink(header) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(header || '');
  return m ? m[1] : null;
}

export function createClient({
  owner, repo, token, label = 'cinemagoal', perPage = 100, fetchImpl, verifyDelayMs = 2500, maxRepairs = 3, onRepair,
} = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  let etag = null;
  let useEtag = true;
  let writeSeq = 0;
  const latestWrite = new Map(); // "id|path" → seq of our newest write to that field

  async function gh(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await doFetch(path.startsWith('http') ? path : base + path, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status !== 304 && !res.ok) {
      let msg = `GitHub ${res.status}`;
      try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
      throw new ApiError(res.status, msg);
    }
    return res;
  }

  // Lists every movie. state=all + sort=updated means any change (including a
  // delete) moves an issue to page 1, so the page-1 ETag is a valid change signal.
  async function list({ force = false } = {}) {
    const url = `/issues?labels=${encodeURIComponent(label)}&state=all&sort=updated&direction=desc&per_page=${perPage}`;
    const conditional = useEtag && etag && !force;
    let first;
    try {
      first = await gh(url, { headers: conditional ? { 'If-None-Match': etag } : {} });
    } catch (e) {
      // Some browsers choke on manual conditional requests; fall back to plain polling.
      if (!conditional || e instanceof ApiError) throw e;
      useEtag = false;
      first = await gh(url);
    }
    if (first.status === 304) return { changed: false };
    let items = await first.json();
    let next = nextLink(first.headers.get('Link'));
    while (next) {
      const res = await gh(next);
      items = items.concat(await res.json());
      next = nextLink(res.headers.get('Link'));
    }
    etag = first.headers.get('ETag');
    return { changed: true, movies: items.map(parseIssue).filter(Boolean) };
  }

  async function create(fields) {
    const movie = emptyMovie(fields);
    const res = await gh('/issues', {
      method: 'POST',
      body: { title: movie.title, body: serializeBody(movie), labels: [label] },
    });
    return parseIssue(await res.json());
  }

  async function get(id) {
    return parseIssue(await (await gh(`/issues/${id}`)).json());
  }

  async function write(id, data, fallbackTitle) {
    const res = await gh(`/issues/${id}`, {
      method: 'PATCH',
      body: { title: data.title || fallbackTitle, body: serializeBody(data) },
    });
    return parseIssue(await res.json());
  }

  // Re-reads the issue right before writing and merges only the changed fields,
  // so two people editing different fields at the same time don't clobber each other.
  // GitHub has no compare-and-swap for issues, so a write that lands in the gap between
  // someone else's read and write can still be reverted; verify() detects and re-applies it.
  async function update(id, patch) {
    const current = await get(id);
    const before = toData(current);
    const leaves = leafPaths(patch);
    const seq = ++writeSeq;
    for (const [p] of leaves) latestWrite.set(`${id}|${p.join('.')}`, seq);
    const result = await write(id, deepMerge(before, patch), current.title);
    if (verifyDelayMs >= 0) setTimeout(() => verify(id, leaves, before, seq, 1), verifyDelayMs);
    return result;
  }

  async function verify(id, leaves, before, seq, attempt) {
    try {
      // Skip fields we've written again since — the newer write owns them.
      const own = leaves.filter(([p]) => latestWrite.get(`${id}|${p.join('.')}`) === seq);
      if (!own.length) return;
      const now = await get(id);
      const nowData = toData(now);
      const lost = lostLeaves(own, before, nowData);
      if (!lost.length) return;
      const repaired = await write(id, deepMerge(nowData, buildPatch(lost)), now.title);
      onRepair?.(repaired);
      if (attempt < maxRepairs) setTimeout(() => verify(id, lost, nowData, seq, attempt + 1), verifyDelayMs);
    } catch { /* next poll will show whatever is on the server */ }
  }

  async function remove(id) {
    const res = await gh(`/issues/${id}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
    return parseIssue(await res.json());
  }

  async function restore(id) {
    const res = await gh(`/issues/${id}`, { method: 'PATCH', body: { state: 'open', state_reason: 'reopened' } });
    return parseIssue(await res.json());
  }

  return { list, create, get, update, remove, restore, resetEtag: () => { etag = null; } };
}

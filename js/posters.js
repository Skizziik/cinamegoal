// Poster / year lookup via Wikipedia (free, no key, CORS-friendly).
// ru.wikipedia finds Russian titles; en.wikipedia fills in posters ru doesn't expose.

import { normalizeTitle } from './store.js';

const RU = 'https://ru.wikipedia.org/w/api.php';
const EN = 'https://en.wikipedia.org/w/api.php';
const FILM_RE = /фильм|мультфильм|комеди|триллер|драма|боевик|film|movie|комикс|киноэпопе/i;
const NOT_FILM_RE = /роман|повесть|писател|актёр|актер|актриса|режиссёр|режиссер|персонаж|певец|певица|novel|actor|actress/i;

// Wikipedia descriptions are inconsistent ("We're the Millers" has no "фильм"),
// so a close title match also counts, unless the page is clearly a book or a person.
function looksLikeFilm(page, query) {
  const desc = page.description || '';
  if (NOT_FILM_RE.test(desc) && !FILM_RE.test(desc)) return false;
  return FILM_RE.test(`${page.title} ${desc}`) || normalizeTitle(cleanTitle(page.title)).includes(normalizeTitle(query));
}

function api(base, params) {
  return `${base}?${new URLSearchParams({ action: 'query', format: 'json', origin: '*', ...params })}`;
}

export function cleanTitle(title) {
  return String(title || '').replace(/\s*\([^()]*(?:фильм|film|мультфильм)[^()]*\)\s*$/iu, '').trim();
}

export function extractYear(...texts) {
  for (const t of texts) {
    const m = /\b(19[0-9]{2}|20[0-9]{2})\b/.exec(t || '');
    if (m) return m[1];
  }
  return '';
}

const bigger = (url) => (url || '').replace(/\/(\d+)px-/, '/500px-');

export async function searchFilms(query, { signal, fetchImpl, limit = 8 } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const ruRes = await doFetch(api(RU, {
    generator: 'search', gsrsearch: `${q} фильм`, gsrlimit: String(limit), gsrnamespace: '0',
    prop: 'pageimages|description|langlinks', piprop: 'thumbnail', pithumbsize: '500',
    pilicense: 'any', lllang: 'en', redirects: '1',
  }), { signal });
  if (!ruRes.ok) throw new Error(`wiki ${ruRes.status}`);
  const ru = await ruRes.json();
  const pages = Object.values(ru.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .filter((p) => looksLikeFilm(p, q));

  const results = pages.map((p) => ({
    page: p.title,
    title: cleanTitle(p.title),
    description: p.description || '',
    year: extractYear(p.title, p.description),
    poster: bigger(p.thumbnail?.source),
    enTitle: p.langlinks?.[0]?.['*'] || '',
  }));

  const missing = results.filter((r) => !r.poster && r.enTitle);
  if (missing.length) {
    try {
      const enRes = await doFetch(api(EN, {
        titles: missing.map((r) => r.enTitle).join('|'),
        prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '500', pilicense: 'any', redirects: '1',
      }), { signal });
      const en = await enRes.json();
      const alias = new Map();
      for (const n of [...(en.query?.normalized || []), ...(en.query?.redirects || [])]) alias.set(n.from, n.to);
      const byTitle = new Map(Object.values(en.query?.pages || {}).map((p) => [p.title, p.thumbnail?.source]));
      for (const r of missing) {
        let t = r.enTitle;
        for (let i = 0; i < 3 && alias.has(t); i++) t = alias.get(t);
        r.poster = bigger(byTitle.get(t));
        if (!r.year) r.year = extractYear(r.enTitle);
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
    }
  }
  return results.map(({ page, title, description, year, poster, enTitle }) => ({
    page, title, description, year, poster: poster || '', original: cleanTitle(enTitle),
  }));
}

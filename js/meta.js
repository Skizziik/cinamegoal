// Movie details (genres, runtime, director, description) from Wikipedia + Wikidata.
import { searchFilms, cleanTitle } from './posters.js';
import { normalizeTitle } from './store.js';

const RU = 'https://ru.wikipedia.org/w/api.php';
const EN = 'https://en.wikipedia.org/w/api.php';
const WD = 'https://www.wikidata.org/w/api.php';
const MINUTE = 'Q7727';
const HOUR = 'Q25235';
const SECOND = 'Q11574';

// Wikidata genres are very fine-grained ("психологический фильм-триллер"),
// so they are folded into a short list of familiar genres for chips and filters.
// Order matters: the first rule that matches a raw genre wins.
export const GENRE_RULES = [
  ['Мультфильм', /анимац|мультфильм|мультипликац|animat|cartoon/],
  ['Мелодрама', /мелодрам|романтическ|romance|romantic/],
  ['Комедия', /комеди|comedy/],
  ['Ужасы', /ужас|хоррор|слэшер|horror|slasher/],
  ['Триллер', /триллер|саспенс|thriller|suspense/],
  ['Детектив', /детектив|тайн|mystery|detective/],
  ['Криминал', /криминал|гангстер|нуар|crime|gangster|noir/],
  ['Фантастика', /фантаст|киберпанк|антиутоп|science fiction|sci-fi|cyberpunk|dystopi/],
  ['Фэнтези', /фэнтези|сказк|fantasy|fairy/],
  ['Боевик', /боевик|экшн|action/],
  ['Приключения', /приключ|роуд-муви|adventure|road movie/],
  ['Биография', /биограф|байопик|biograph|biopic/],
  ['Мюзикл', /мюзикл|музыкальн|musical|music film/],
  ['Военный', /военн|war film/],
  ['Исторический', /историческ|historical|period/],
  ['Семейный', /семейн|детск|family|children/],
  ['Спорт', /спорт|sport/],
  ['Документальный', /документ|documentary/],
  ['Вестерн', /вестерн|western/],
  ['Драма', /драм|drama/],
];

export function genreBuckets(rawGenres = [], max = 4) {
  const out = [];
  for (const g of rawGenres) {
    const rule = GENRE_RULES.find(([, re]) => re.test(String(g).toLowerCase()));
    if (rule && !out.includes(rule[0])) out.push(rule[0]);
  }
  return out.slice(0, max);
}

export const movieGenres = (m) => genreBuckets(m?.details?.genres);

export function formatRuntime(min) {
  if (!Number.isFinite(min) || min <= 0) return '';
  const h = Math.floor(min / 60);
  const mm = Math.round(min % 60);
  if (!h) return `${mm} мин`;
  return mm ? `${h} ч ${mm} мин` : `${h} ч`;
}

// Length filter for "что посмотреть на 1,5 часа". Small tolerance: a 95-minute film is "about 1.5 h".
export const LENGTHS = {
  any: { label: 'Любая длина', test: () => true },
  short: { label: 'До 1,5 ч', test: (min) => min > 0 && min <= 95 },
  medium: { label: 'До 2 ч', test: (min) => min > 0 && min <= 125 },
  long: { label: 'Больше 2 ч', test: (min) => min > 125 },
};

export function matchesLength(m, key) {
  const rule = LENGTHS[key] || LENGTHS.any;
  if (key === 'any' || !LENGTHS[key]) return true;
  return rule.test(Number(m?.details?.runtime) || 0);
}

export function durationMinutes(value) {
  if (!value) return null;
  const amount = Math.abs(parseFloat(value.amount));
  if (!Number.isFinite(amount)) return null;
  const unit = String(value.unit || '').split('/').pop();
  if (unit === HOUR) return Math.round(amount * 60);
  if (unit === SECOND) return Math.round(amount / 60);
  return Math.round(amount); // minutes (or unitless, which Wikidata uses for minutes too)
}

export function cleanDescription(text, max = 700) {
  let s = String(text || '')
    .replace(/́/g, '') // stress marks
    .replace(/\s*\((?:англ|фр|нем|исп|итал|яп|кор)\.[^()]*\)/g, '') // "(англ. Shutter Island)"
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return s;
}

const qs = (base, params) => `${base}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;

// Picks the Wikipedia page for a movie: an explicit page wins, otherwise a search
// result with the same title (and the same year when we know it).
export async function findPage(movie, { fetchImpl, signal } = {}) {
  if (movie.details?.wiki) return movie.details.wiki;
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const results = await searchFilms(movie.title, { fetchImpl, signal });
  const want = normalizeTitle(cleanTitle(movie.title));
  const withPage = results.filter((r) => r.page);
  const strong = withPage.filter((r) => normalizeTitle(r.title) === want || (r.original && normalizeTitle(r.original) === want));
  // "Апокалипсис по-голливудски" → «Конец света 2013: Апокалипсис по-голливудски»: only with the same year.
  const weak = want.length >= 6 ? withPage.filter((r) => !strong.includes(r) && normalizeTitle(r.title).includes(want)) : [];
  let hit;
  if (movie.year) {
    const y = String(movie.year);
    hit = strong.find((r) => r.year === y) || strong.find((r) => !r.year) || weak.find((r) => r.year === y);
  } else {
    hit = strong[0];
  }
  if (hit) return hit.page;

  // Not on Russian Wikipedia: try the English article by the original title.
  if (movie.original) {
    const en = await (await doFetch(qs(EN, { action: 'query', titles: movie.original, prop: 'pageprops', redirects: '1' }), { signal })).json();
    const page = Object.values(en.query?.pages || {})[0];
    if (page && page.missing === undefined && !('disambiguation' in (page.pageprops || {}))) return `en:${page.title}`;
  }
  return null;
}

// "en:Title" → English Wikipedia; plain titles are Russian.
export function splitWiki(wiki) {
  const m = /^(en):(.+)$/.exec(String(wiki || ''));
  return m ? { lang: m[1], title: m[2] } : { lang: 'ru', title: String(wiki || '') };
}

export function wikiUrl(wiki) {
  const { lang, title } = splitWiki(wiki);
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

const isAnimation = (label) => /анимац|мультфильм|мультипликац|animat/i.test(label);

export async function fetchDetails(wiki, { fetchImpl, signal } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const get = async (url) => {
    const res = await doFetch(url, { signal });
    if (!res.ok) throw new Error(`wiki ${res.status}`);
    return res.json();
  };
  const { lang, title } = splitWiki(wiki);
  const res = await get(qs(lang === 'en' ? EN : RU, {
    action: 'query', titles: title, prop: 'extracts|pageprops', exintro: '1', explaintext: '1',
    exsentences: '3', ppprop: 'wikibase_item', redirects: '1',
  }));
  const page = Object.values(res.query?.pages || {})[0];
  if (!page || page.missing !== undefined) return null;
  const details = {
    wiki: lang === 'en' ? `en:${page.title}` : page.title,
    wikidata: page.pageprops?.wikibase_item || '',
    // An English intro would look out of place among Russian text, so skip it.
    description: lang === 'en' ? '' : cleanDescription(page.extract),
    genres: [],
    directors: [],
    runtime: null,
    fetchedAt: new Date().toISOString(),
  };
  const q = details.wikidata;
  if (!q) return details;

  const wd = await get(qs(WD, { action: 'wbgetentities', ids: q, props: 'claims' }));
  const claims = wd.entities?.[q]?.claims || {};
  const ids = (p) => (claims[p] || []).map((s) => s.mainsnak?.datavalue?.value?.id).filter(Boolean);
  details.runtime = durationMinutes(claims.P2047?.[0]?.mainsnak?.datavalue?.value);
  const genreIds = ids('P136').slice(0, 15);
  const directorIds = ids('P57').slice(0, 3);
  // "Animated film" usually sits in "instance of" (P31), not in genres.
  const kindIds = ids('P31').slice(0, 5);
  const all = [...new Set([...genreIds, ...directorIds, ...kindIds])];
  if (all.length) {
    const labels = await get(qs(WD, { action: 'wbgetentities', ids: all.join('|'), props: 'labels', languages: 'ru|en' }));
    const label = (id) => labels.entities?.[id]?.labels?.ru?.value || labels.entities?.[id]?.labels?.en?.value || '';
    const animated = kindIds.map(label).filter(isAnimation);
    details.genres = [...animated.slice(0, 1), ...genreIds.map(label)].filter(Boolean);
    details.directors = directorIds.map(label).filter(Boolean);
  }
  return details;
}

// Details for a movie, or {missing:true} when Wikipedia has no confident match
// (stored so clients don't retry the lookup forever).
export async function lookupMovie(movie, opts = {}) {
  const page = await findPage(movie, opts);
  if (!page) return { missing: true, fetchedAt: new Date().toISOString() };
  return (await fetchDetails(page, opts)) || { missing: true, fetchedAt: new Date().toISOString() };
}

export function trailerUrl(m) {
  const q = [m.title, m.year, 'трейлер'].filter(Boolean).join(' ');
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

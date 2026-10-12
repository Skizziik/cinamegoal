// One-off: fills the repo with the initial movie list. Skips titles that already exist.
// Usage: GH_TOKEN=$(gh auth token) node scripts/seed.mjs
import { createClient, normalizeTitle } from '../js/store.js';
import { searchFilms } from '../js/posters.js';
import { CONFIG } from '../js/config.js';

const UA = { 'User-Agent': 'Cinemagoal-seed/1.0 (https://github.com/Skizziik/cinamegoal)' };
const wikiFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOVIES = [
  { title: 'Сводишь с ума', q: 'Сводишь с ума' },
  { title: 'Остров проклятых', q: 'Остров проклятых' },
  { title: 'Неуязвимый — Сплит — Стекло — Стекло 2', q: 'Неуязвимый 2000', pick: (r) => /Eastrail/i.test(r.poster) },
  { title: 'Легенда', q: 'Легенда 2015 Харди' },
  { title: 'Бойцовский клуб', q: 'Бойцовский клуб' },
  { title: 'Поймай меня, если сможешь', q: 'Поймай меня, если сможешь' },
  { title: 'Лицо со шрамом', q: 'Лицо со шрамом 1983' },
  { title: 'Мы — Миллеры', q: 'Мы — Миллеры' },
  { title: 'Апокалипсис по-голливудски', q: 'Конец света 2013 Апокалипсис по-голливудски' },
  { title: 'Суперчел', en: 'Superwho?', year: '2021' },
];

async function enPoster(title) {
  const u = `https://en.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', format: 'json', titles: title, prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '500', pilicense: 'any', redirects: '1' })}`;
  const j = await (await wikiFetch(u)).json();
  return Object.values(j.query?.pages || {})[0]?.thumbnail?.source || '';
}

const token = process.env.GH_TOKEN;
if (!token) throw new Error('GH_TOKEN is required');
const client = createClient({ owner: CONFIG.owner, repo: CONFIG.repo, label: CONFIG.label, token, verifyDelayMs: -1 });
const existing = new Set((await client.list({ force: true })).movies.filter((m) => !m.deleted).map((m) => normalizeTitle(m.title)));

const start = Date.parse('2026-10-12T12:00:00Z');
for (const [i, m] of MOVIES.entries()) {
  if (existing.has(normalizeTitle(m.title))) { console.log('skip', m.title); continue; }
  let info = { poster: '', year: m.year || '', original: m.en || '' };
  try {
    if (m.en) info.poster = await enPoster(m.en);
    else {
      const res = (await searchFilms(m.q, { fetchImpl: wikiFetch })).filter((r) => r.poster);
      const hit = (m.pick && res.find(m.pick)) || res[0];
      if (hit) info = { poster: hit.poster, year: hit.year || (m.pick ? '' : ''), original: hit.original };
    }
  } catch (e) { console.warn('poster lookup failed for', m.title, e.message); }
  if (m.pick) info.year = '';
  const created = await client.create({
    title: m.title, ...info, addedBy: 'alina',
    // keep the original list order: item 1 is the newest
    addedAt: new Date(start - i * 60000).toISOString(),
  });
  console.log(`#${created.id}`, created.title, '|', created.year, '|', created.original, '|', created.poster ? 'poster ✓' : 'no poster');
  await sleep(1200);
}

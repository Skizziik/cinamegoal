// Fills Wikipedia details for movies that don't have them yet.
// Usage: GH_TOKEN=$(gh auth token) node scripts/enrich.mjs [--write] [--force]
import { createClient } from '../js/store.js';
import { lookupMovie, genreBuckets, formatRuntime } from '../js/meta.js';
import { CONFIG } from '../js/config.js';

const write = process.argv.includes('--write');
const force = process.argv.includes('--force');
const UA = { 'User-Agent': 'Cinemagoal-enrich/1.0 (https://github.com/Skizziik/cinamegoal)' };
const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = createClient({ owner: CONFIG.owner, repo: CONFIG.repo, label: CONFIG.label, token: process.env.GH_TOKEN, verifyDelayMs: -1 });
const { movies } = await client.list({ force: true });
for (const m of movies.filter((x) => !x.deleted).sort((a, b) => a.id - b.id)) {
  if (m.details && !force) { console.log(`#${m.id} ${m.title}: already has details`); continue; }
  const d = await lookupMovie({ ...m, details: null }, { fetchImpl });
  console.log(`#${m.id} ${m.title} (${m.year || '?'}) →`, d.missing ? 'NOT FOUND'
    : `${d.wiki} | ${genreBuckets(d.genres).join(', ')} | ${formatRuntime(d.runtime)} | ${d.directors.join(', ')}`);
  if (write) await client.update(m.id, { details: d });
  await sleep(800);
}

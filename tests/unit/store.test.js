import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createClient, serializeBody, parseIssue, deepMerge, averageRating, clampRating, normalizeTitle, emptyMovie, ApiError,
  leafPaths, buildPatch, lostLeaves,
} from '../../js/store.js';
import { cleanTitle, extractYear, searchFilms } from '../../js/posters.js';
import { FakeGitHub } from '../fake-github.js';

const setup = () => {
  const gh = new FakeGitHub();
  const client = createClient({ owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl: gh.fetch, verifyDelayMs: -1 });
  return { gh, client };
};

test('serialize → parse roundtrip keeps every field', () => {
  const m = emptyMovie({
    title: 'Остров проклятых', year: '2010', poster: 'https://x/y.jpg', addedBy: 'alina', note: 'Совет Саши',
    watched: true, watchedAt: '2026-10-10T20:00:00.000Z', ratings: { maksim: 9, alina: 8 }, reviews: { maksim: 'Вау', alina: 'Жутко' },
  });
  const parsed = parseIssue({ number: 7, title: m.title, body: serializeBody(m), state: 'open', created_at: 'x', updated_at: 'y' });
  for (const k of ['title', 'year', 'poster', 'addedBy', 'note', 'watched', 'watchedAt', 'ratings', 'reviews', 'addedAt']) {
    assert.deepEqual(parsed[k], m[k], k);
  }
  assert.equal(parsed.id, 7);
  assert.equal(parsed.deleted, false);
});

test('user text containing comment terminators cannot break the data block', () => {
  const nasty = 'Фильм --> <!-- cinemagoal:data {"title":"hack"} --> "кавычки" </script>';
  const m = emptyMovie({ title: nasty, note: nasty, reviews: { maksim: nasty, alina: '' } });
  const body = serializeBody(m);
  const parsed = parseIssue({ number: 1, title: 't', body, state: 'open' });
  assert.equal(parsed.title, nasty);
  assert.equal(parsed.note, nasty);
  assert.equal(parsed.reviews.maksim, nasty);
});

test('issues without a data block still show up with defaults; PRs are skipped', () => {
  const p = parseIssue({ number: 3, title: 'Ручной', body: 'просто текст', state: 'closed', created_at: '2026-01-01T00:00:00Z' });
  assert.equal(p.title, 'Ручной');
  assert.equal(p.addedAt, '2026-01-01T00:00:00Z');
  assert.equal(p.deleted, true);
  assert.deepEqual(p.ratings, { maksim: null, alina: null });
  assert.equal(parseIssue({ number: 4, title: 'pr', pull_request: {} }), null);
});

test('deepMerge merges nested objects without touching siblings', () => {
  const base = { ratings: { maksim: 5, alina: 7 }, reviews: { maksim: 'a', alina: 'b' }, title: 'x' };
  const out = deepMerge(base, { ratings: { alina: 9 }, title: undefined });
  assert.deepEqual(out, { ratings: { maksim: 5, alina: 9 }, reviews: { maksim: 'a', alina: 'b' }, title: 'x' });
  assert.equal(base.ratings.alina, 7, 'input not mutated');
  assert.deepEqual(deepMerge({ a: 1 }, { a: null }), { a: null });
});

test('ratings: clamp and average', () => {
  assert.equal(clampRating(0), 1);
  assert.equal(clampRating(11), 10);
  assert.equal(clampRating('7'), 7);
  assert.equal(clampRating(''), null);
  assert.equal(clampRating('abc'), null);
  assert.equal(averageRating({ ratings: { maksim: 8, alina: 9 } }), 8.5);
  assert.equal(averageRating({ ratings: { maksim: 7, alina: null } }), 7);
  assert.equal(averageRating({ ratings: { maksim: null, alina: null } }), null);
  assert.equal(averageRating({ ratings: { maksim: 7, alina: 8 }, }), 7.5);
});

test('normalizeTitle ignores case, ё and punctuation', () => {
  assert.equal(normalizeTitle('Мы — Миллеры'), normalizeTitle('мы миллеры'));
  assert.equal(normalizeTitle('Ёлки'), normalizeTitle('елки'));
});

test('client: create, list, update, remove, restore', async () => {
  const { gh, client } = setup();
  const created = await client.create({ title: 'Бойцовский клуб', addedBy: 'maksim' });
  assert.equal(created.id, 1);
  assert.deepEqual(gh.issues[0].labels, [{ name: 'cinemagoal' }]);

  let r = await client.list();
  assert.equal(r.changed, true);
  assert.equal(r.movies.length, 1);
  assert.equal(r.movies[0].title, 'Бойцовский клуб');

  const updated = await client.update(1, { watched: true, ratings: { alina: 10 } });
  assert.equal(updated.watched, true);
  assert.equal(updated.ratings.alina, 10);
  assert.equal(updated.ratings.maksim, null);

  const renamed = await client.update(1, { title: 'Fight Club' });
  assert.equal(gh.issues[0].title, 'Fight Club', 'issue title follows movie title');
  assert.equal(renamed.ratings.alina, 10);

  const removed = await client.remove(1);
  assert.equal(removed.deleted, true);
  r = await client.list();
  assert.equal(r.movies[0].deleted, true, 'closed issues come back flagged as deleted');
  const restored = await client.restore(1);
  assert.equal(restored.deleted, false);
});

test('client: ETag polling returns changed=false when nothing changed', async () => {
  const { client } = setup();
  await client.create({ title: 'A' });
  assert.equal((await client.list()).changed, true);
  assert.equal((await client.list()).changed, false);
  await client.update(1, { note: 'x' });
  assert.equal((await client.list()).changed, true);
  assert.equal((await client.list({ force: true })).changed, true);
});

test('client: concurrent edits from two people to different fields both survive', async () => {
  const gh = new FakeGitHub();
  const a = createClient({ owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl: gh.fetch, verifyDelayMs: -1 });
  const b = createClient({ owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl: gh.fetch, verifyDelayMs: -1 });
  await a.create({ title: 'Лицо со шрамом' });
  await a.update(1, { ratings: { maksim: 9 } });
  await b.update(1, { ratings: { alina: 7 }, reviews: { alina: 'Долго, но круто' } });
  await a.update(1, { reviews: { maksim: 'Шедевр' } });
  const final = await b.get(1);
  assert.deepEqual(final.ratings, { maksim: 9, alina: 7 });
  assert.deepEqual(final.reviews, { maksim: 'Шедевр', alina: 'Долго, но круто' });
});

test('client: paginates beyond 100 movies', async () => {
  const gh = new FakeGitHub();
  const client = createClient({ owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl: gh.fetch, perPage: 5 });
  for (let i = 0; i < 12; i++) await client.create({ title: `Фильм ${i}` });
  const r = await client.list();
  assert.equal(r.movies.length, 12);
  assert.equal(new Set(r.movies.map((m) => m.id)).size, 12);
});

test('client: ignores issues without the label and surfaces API errors', async () => {
  const { gh, client } = setup();
  gh.seed('Баг-репорт', 'не фильм', ['bug']);
  await client.create({ title: 'Легенда' });
  const r = await client.list();
  assert.deepEqual(r.movies.map((m) => m.title), ['Легенда']);

  const bad = createClient({ owner: 'Skizziik', repo: 'cinamegoal', token: 'wrong', fetchImpl: gh.fetch });
  await assert.rejects(bad.list(), (e) => e instanceof ApiError && e.status === 401);
  const anon = createClient({ owner: 'Skizziik', repo: 'cinamegoal', token: '', fetchImpl: gh.fetch });
  assert.equal((await anon.list()).movies.length, 1, 'read-only access works without a token');
  await assert.rejects(anon.create({ title: 'x' }), (e) => e.status === 401);
});

test('posters: title cleanup and year extraction', () => {
  assert.equal(cleanTitle('Легенда (фильм, 2015)'), 'Легенда');
  assert.equal(cleanTitle('Остров проклятых (фильм)'), 'Остров проклятых');
  assert.equal(cleanTitle('Shutter Island (film)'), 'Shutter Island');
  assert.equal(cleanTitle('Мы — Миллеры'), 'Мы — Миллеры');
  assert.equal(extractYear('фильм 2000 года'), '2000');
  assert.equal(extractYear('', 'фильм Стивена Спилберга (2002)'), '2002');
  assert.equal(extractYear('без года'), '');
});

test('posters: searchFilms merges ru results with en posters', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === 'ru.wikipedia.org') {
      return Response.json({ query: { pages: {
        1: { index: 1, title: 'Остров проклятых (фильм)', description: 'триллер Скорсезе 2010 года', langlinks: [{ lang: 'en', '*': 'Shutter Island (film)' }] },
        2: { index: 2, title: 'Остров проклятых', description: 'роман Денниса Лихейна' },
        3: { index: 3, title: 'Легенда (фильм, 2015)', description: 'криминальный фильм', thumbnail: { source: 'https://up/thumb/a/220px-Legend.jpg' } },
      } } });
    }
    assert.equal(u.searchParams.get('titles'), 'Shutter Island (film)');
    return Response.json({ query: { pages: { 9: { title: 'Shutter Island (film)', thumbnail: { source: 'https://up/thumb/b/330px-Shutter.jpg' } } } } });
  };
  const res = await searchFilms('Остров', { fetchImpl });
  assert.equal(res.length, 2, 'the novel is filtered out');
  assert.deepEqual(res[0], { title: 'Остров проклятых', description: 'триллер Скорсезе 2010 года', year: '2010', poster: 'https://up/thumb/b/500px-Shutter.jpg', original: 'Shutter Island' });
  assert.equal(res[1].poster, 'https://up/thumb/a/500px-Legend.jpg');
  assert.equal(res[1].year, '2015');
  assert.equal(calls.length, 2);
  assert.deepEqual(await searchFilms('a', { fetchImpl }), [], 'too-short queries skip the network');
});

test('patch helpers: leaves, rebuild, lost-update detection', () => {
  const patch = { ratings: { alina: 9 }, reviews: { alina: 'ok' }, watched: true };
  const leaves = leafPaths(patch);
  assert.deepEqual(leaves, [[['ratings', 'alina'], 9], [['reviews', 'alina'], 'ok'], [['watched'], true]]);
  assert.deepEqual(buildPatch(leaves), patch);
  const before = { ratings: { alina: null }, reviews: { alina: '' }, watched: false };
  const now = { ratings: { alina: null }, reviews: { alina: 'changed by someone' }, watched: true };
  assert.deepEqual(lostLeaves(leaves, before, now), [[['ratings', 'alina'], 9]], 'only reverted fields count as lost');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const twoClients = (gh, extra = {}) => ['a', 'b'].map(() => createClient({
  owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl: gh.fetch, verifyDelayMs: 5, ...extra,
}));

test('client: truly simultaneous writes (interleaved read/write) are repaired', async () => {
  const gh = new FakeGitHub();
  let repairs = 0;
  const [a, b] = twoClients(gh, { onRepair: () => { repairs++; } });
  await a.create({ title: 'Легенда' });
  // Both read before either writes → the second write reverts the first one.
  await Promise.all([
    a.update(1, { ratings: { maksim: 6 }, reviews: { maksim: 'Том Харди x2' } }),
    b.update(1, { ratings: { alina: 10 }, reviews: { alina: 'Обожаю' } }),
  ]);
  await sleep(80);
  const final = await a.get(1);
  assert.deepEqual(final.ratings, { maksim: 6, alina: 10 });
  assert.deepEqual(final.reviews, { maksim: 'Том Харди x2', alina: 'Обожаю' });
  assert.ok(repairs >= 1, 'a repair write happened');
});

test('client: repair never resurrects a value the same person changed again', async () => {
  const gh = new FakeGitHub();
  const [a] = twoClients(gh);
  await a.create({ title: 'Суперчел' });
  await a.update(1, { ratings: { maksim: 6 } });
  await a.update(1, { ratings: { maksim: null } }); // cleared right after
  await sleep(60);
  assert.equal((await a.get(1)).ratings.maksim, null);
});

test('client: falls back to plain polling if a conditional request fails', async () => {
  const gh = new FakeGitHub();
  let failConditional = true;
  const fetchImpl = async (url, init) => {
    if (failConditional && init.headers['If-None-Match']) throw new TypeError('Load failed');
    return gh.fetch(url, init);
  };
  const c = createClient({ owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl, verifyDelayMs: -1 });
  await c.create({ title: 'A' });
  assert.equal((await c.list()).changed, true);
  assert.equal((await c.list()).changed, true, 'conditional failed → refetched without ETag');
  failConditional = false;
  assert.equal((await c.list()).changed, true, 'stays on plain polling');
});

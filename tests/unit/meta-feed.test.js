import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  genreBuckets, formatRuntime, matchesLength, durationMinutes, cleanDescription, fetchDetails, findPage, lookupMovie, trailerUrl, wikiUrl,
} from '../../js/meta.js';
import {
  eventKey, logPatch, buildFeed, eventText, unreadCount, reactionsOn, hasReaction, dayLabel, LOG_LIMIT,
} from '../../js/feed.js';
import { emptyMovie, createClient, serializeBody, parseIssue } from '../../js/store.js';
import { FakeGitHub } from '../fake-github.js';

const SHUTTER_GENRES = ['фильм-триллер', 'драматический фильм', 'криминальный триллер', 'криминальный фильм',
  'психологический фильм ужасов', 'неонуар', 'фильм-тайна', 'боевик'];

test('genres are folded into familiar buckets, max 4, in source order', () => {
  assert.deepEqual(genreBuckets(SHUTTER_GENRES), ['Триллер', 'Драма', 'Криминал', 'Ужасы']);
  assert.deepEqual(genreBuckets(['комедийный фильм', 'криминальный фильм', 'роуд-муви']), ['Комедия', 'Криминал', 'Приключения']);
  assert.deepEqual(genreBuckets(['мелодрама', 'романтическая комедия']), ['Мелодрама']);
  assert.deepEqual(genreBuckets(['компьютерная анимация', 'семейный фильм', 'комедийный фильм']), ['Мультфильм', 'Семейный', 'Комедия']);
  assert.deepEqual(genreBuckets(['научно-фантастический фильм', 'фантастический боевик']), ['Фантастика']);
  assert.deepEqual(genreBuckets(undefined), []);
  assert.deepEqual(genreBuckets(['что-то непонятное']), []);
});

test('runtime: parsing Wikidata units, formatting, length filter', () => {
  assert.equal(durationMinutes({ amount: '+138', unit: 'http://www.wikidata.org/entity/Q7727' }), 138);
  assert.equal(durationMinutes({ amount: '+110.0', unit: 'http://www.wikidata.org/entity/Q7727' }), 110);
  assert.equal(durationMinutes({ amount: '+1.5', unit: 'http://www.wikidata.org/entity/Q25235' }), 90);
  assert.equal(durationMinutes({ amount: '+5400', unit: 'http://www.wikidata.org/entity/Q11574' }), 90);
  assert.equal(durationMinutes(undefined), null);
  assert.equal(formatRuntime(138), '2 ч 18 мин');
  assert.equal(formatRuntime(120), '2 ч');
  assert.equal(formatRuntime(45), '45 мин');
  assert.equal(formatRuntime(null), '');
  const m = (runtime) => ({ details: { runtime } });
  assert.equal(matchesLength(m(92), 'short'), true, 'a 92-minute film counts as "до 1,5 ч"');
  assert.equal(matchesLength(m(110), 'short'), false);
  assert.equal(matchesLength(m(110), 'medium'), true);
  assert.equal(matchesLength(m(138), 'long'), true);
  assert.equal(matchesLength(m(null), 'short'), false, 'unknown length is excluded from length filters');
  assert.equal(matchesLength(m(null), 'any'), true);
});

test('description cleanup', () => {
  assert.equal(cleanDescription('«Остро́в прокля́тых» (англ. Shutter Island) — триллер.'), '«Остров проклятых» — триллер.');
  const long = cleanDescription('слово '.repeat(200), 50);
  assert.ok(long.length <= 51 && long.endsWith('…'));
});

function wikiMock({ withWikidata = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const p = u.searchParams;
    if (u.host === 'ru.wikipedia.org' && p.get('generator') === 'search') {
      return Response.json({ query: { pages: {
        1: { index: 1, title: 'Легенда (фильм, 1985)', description: 'фэнтезийный фильм 1985 года' },
        2: { index: 2, title: 'Легенда (фильм, 2015)', description: 'криминальный фильм 2015 года', langlinks: [{ '*': 'Legend (2015 film)' }] },
        3: { index: 3, title: 'Легенда № 17', description: 'спортивный фильм 2013 года' },
      } } });
    }
    if (u.host === 'en.wikipedia.org') return Response.json({ query: { pages: {} } });
    if (u.host === 'ru.wikipedia.org') {
      return Response.json({ query: { pages: { 9: { title: p.get('titles'), extract: '«Леге́нда» (англ. Legend) — криминальный триллер.', pageprops: withWikidata ? { wikibase_item: 'Q1' } : {} } } } });
    }
    if (p.get('props') === 'claims') {
      return Response.json({ entities: { Q1: { claims: {
        P136: [{ mainsnak: { datavalue: { value: { id: 'Q10' } } } }, { mainsnak: { datavalue: { value: { id: 'Q11' } } } }],
        P57: [{ mainsnak: { datavalue: { value: { id: 'Q20' } } } }],
        P2047: [{ mainsnak: { datavalue: { value: { amount: '+132', unit: 'http://www.wikidata.org/entity/Q7727' } } } }],
      } } } });
    }
    return Response.json({ entities: {
      Q10: { labels: { ru: { value: 'криминальный фильм' } } },
      Q11: { labels: { en: { value: 'biographical film' } } },
      Q20: { labels: { ru: { value: 'Брайан Хелгеленд' } } },
    } });
  };
  return { fetchImpl, calls };
}

test('findPage prefers the same title AND year; refuses a wrong-year match', async () => {
  const { fetchImpl } = wikiMock();
  assert.equal(await findPage({ title: 'Легенда', year: '2015' }, { fetchImpl }), 'Легенда (фильм, 2015)');
  assert.equal(await findPage({ title: 'Легенда', year: '1985' }, { fetchImpl }), 'Легенда (фильм, 1985)');
  assert.equal(await findPage({ title: 'Легенда', year: '1999' }, { fetchImpl }), null);
  assert.equal(await findPage({ title: 'Легенда' }, { fetchImpl }), 'Легенда (фильм, 1985)');
  assert.equal(await findPage({ title: 'Legend', year: '2015' }, { fetchImpl }), 'Легенда (фильм, 2015)', 'matches the original title too');
  assert.equal(await findPage({ title: 'x', details: { wiki: 'Known page' } }, { fetchImpl }), 'Known page');
});

test('fetchDetails combines Wikipedia text with Wikidata genres, director, runtime', async () => {
  const { fetchImpl } = wikiMock();
  const d = await fetchDetails('Легенда (фильм, 2015)', { fetchImpl });
  assert.equal(d.wiki, 'Легенда (фильм, 2015)');
  assert.equal(d.wikidata, 'Q1');
  assert.equal(d.description, '«Легенда» — криминальный триллер.');
  assert.deepEqual(d.genres, ['криминальный фильм', 'biographical film']);
  assert.deepEqual(d.directors, ['Брайан Хелгеленд']);
  assert.equal(d.runtime, 132);
  assert.deepEqual(genreBuckets(d.genres), ['Криминал', 'Биография']);

  const noWd = await fetchDetails('Легенда (фильм, 2015)', { fetchImpl: wikiMock({ withWikidata: false }).fetchImpl });
  assert.deepEqual([noWd.genres, noWd.runtime], [[], null]);

  const missing = await lookupMovie({ title: 'Легенда', year: '1999' }, { fetchImpl });
  assert.equal(missing.missing, true);
  const found = await lookupMovie({ title: 'Легенда', year: '2015' }, { fetchImpl });
  assert.equal(found.runtime, 132);
});

test('findPage: year-less articles, longer article titles, English fallback', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get('gsrsearch') || '';
    if (u.host === 'en.wikipedia.org' && u.searchParams.get('titles') === 'Superwho?') {
      return Response.json({ query: { pages: { 5: { title: 'Superwho?', pageprops: { wikibase_item: 'Q9' } } } } });
    }
    if (u.host === 'en.wikipedia.org' && u.searchParams.get('titles') === 'Ambiguous') {
      return Response.json({ query: { pages: { 6: { title: 'Ambiguous', pageprops: { disambiguation: '' } } } } });
    }
    if (u.host === 'en.wikipedia.org') return Response.json({ query: { pages: { '-1': { missing: '' } } } });
    if (q.startsWith('Мы')) return Response.json({ query: { pages: { 1: { index: 1, title: 'Мы — Миллеры', description: "We're the Millers" } } } });
    if (q.startsWith('Апокалипсис')) {
      return Response.json({ query: { pages: {
        1: { index: 1, title: 'Апокалипсис сегодня', description: 'военный фильм 1979 года' },
        2: { index: 2, title: 'Конец света 2013: Апокалипсис по-голливудски', description: 'фильм 2013 года' },
      } } });
    }
    return Response.json({ query: { pages: {} } });
  };
  assert.equal(await findPage({ title: 'Мы — Миллеры', year: '2013' }, { fetchImpl }), 'Мы — Миллеры', 'article without a year still matches by title');
  assert.equal(await findPage({ title: 'Апокалипсис по-голливудски', year: '2013' }, { fetchImpl }), 'Конец света 2013: Апокалипсис по-голливудски');
  assert.equal(await findPage({ title: 'Апокалипсис по-голливудски', year: '2014' }, { fetchImpl }), null, 'partial title needs the same year');
  assert.equal(await findPage({ title: 'Суперчел', year: '2021', original: 'Superwho?' }, { fetchImpl }), 'en:Superwho?');
  assert.equal(await findPage({ title: 'Суперчел', original: 'Ambiguous' }, { fetchImpl }), null, 'disambiguation pages are skipped');
  assert.equal(await findPage({ title: 'Суперчел' }, { fetchImpl }), null);
});

test('English-article details skip the English intro; animation comes from "instance of"', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host === 'en.wikipedia.org') return Response.json({ query: { pages: { 5: { title: 'Zootopia', extract: 'Zootopia is a 2016 American animated film.', pageprops: { wikibase_item: 'Q15270647' } } } } });
    if (u.searchParams.get('props') === 'claims') {
      return Response.json({ entities: { Q15270647: { claims: {
        P31: [{ mainsnak: { datavalue: { value: { id: 'Q29168811' } } } }],
        P136: [{ mainsnak: { datavalue: { value: { id: 'Q157443' } } } }],
      } } } });
    }
    return Response.json({ entities: {
      Q29168811: { labels: { ru: { value: 'полнометражный анимационный фильм' } } },
      Q157443: { labels: { ru: { value: 'комедийный фильм' } } },
    } });
  };
  const d = await fetchDetails('en:Zootopia', { fetchImpl });
  assert.equal(d.wiki, 'en:Zootopia');
  assert.equal(d.description, '');
  assert.deepEqual(d.genres, ['полнометражный анимационный фильм', 'комедийный фильм']);
  assert.deepEqual(genreBuckets(d.genres), ['Мультфильм', 'Комедия']);
  assert.equal(wikiUrl('en:Zootopia'), 'https://en.wikipedia.org/wiki/Zootopia');
  assert.equal(wikiUrl('Сплит (фильм)'), `https://ru.wikipedia.org/wiki/${encodeURIComponent('Сплит_(фильм)')}`);
});

test('trailer link searches YouTube', () => {
  assert.equal(trailerUrl({ title: 'Сплит', year: '2016' }), 'https://www.youtube.com/results?search_query=%D0%A1%D0%BF%D0%BB%D0%B8%D1%82%202016%20%D1%82%D1%80%D0%B5%D0%B9%D0%BB%D0%B5%D1%80');
});

test('event keys: ratings/reviews coalesce within 10 minutes, others are unique', () => {
  const t = Date.parse('2026-10-12T20:01:00Z');
  assert.equal(eventKey({ type: 'rate', who: 'alina', t }), eventKey({ type: 'rate', who: 'alina', t: t + 60000 }));
  assert.notEqual(eventKey({ type: 'rate', who: 'alina', t }), eventKey({ type: 'rate', who: 'maksim', t }));
  assert.notEqual(eventKey({ type: 'vote', who: 'alina', t }), eventKey({ type: 'vote', who: 'alina', t }));
});

test('logPatch prunes the oldest events beyond the limit', () => {
  const log = {};
  for (let i = 0; i < LOG_LIMIT; i++) log[`k${i}`] = { type: 'vote', who: 'maksim', t: 1000 + i, value: true };
  const patch = logPatch({ log }, { type: 'watch', who: 'alina', t: 99999 });
  const nulls = Object.entries(patch.log).filter(([, v]) => v === null).map(([k]) => k);
  assert.deepEqual(nulls, ['k0']);
  assert.equal(Object.values(patch.log).filter(Boolean).length, 1);
  assert.deepEqual(Object.keys(logPatch({ log: {} }, { type: 'watch', who: 'alina', t: 1 }).log).length, 1);
});

test('feed: synthetic "added" events + logged events, newest first, readable Russian text', () => {
  const a = { ...emptyMovie({ title: 'Сплит', addedBy: 'alina', addedAt: '2026-10-10T10:00:00Z' }), id: 1 };
  a.log = {
    x: { type: 'vote', who: 'maksim', t: Date.parse('2026-10-11T10:00:00Z'), value: true },
    y: { type: 'rate', who: 'alina', t: Date.parse('2026-10-12T10:00:00Z'), value: 9 },
    z: null,
  };
  const gone = { ...emptyMovie({ title: 'Удалён' }), id: 2, deleted: true, log: { q: { type: 'watch', who: 'alina', t: Date.now() } } };
  const tmp = { ...emptyMovie({ title: 'Ещё не создан' }), id: 'tmp-1' };
  const feed = buildFeed([a, gone, tmp]);
  assert.deepEqual(feed.map((e) => e.type), ['rate', 'vote', 'add']);
  assert.deepEqual(feed.map(eventText), [
    'Алина поставила 9/10 фильму «Сплит»',
    'Максим хочет посмотреть «Сплит»',
    'Алина добавила «Сплит»',
  ]);
  assert.equal(eventText({ type: 'watch', who: 'maksim', title: 'Легенда' }), 'Максим отметил «Легенда» просмотренным');
  assert.equal(eventText({ type: 'review', who: 'alina', title: 'Легенда' }), 'Алина написала отзыв о «Легенда»');
  assert.equal(eventText({ type: 'vote', who: 'alina', value: false, title: 'X' }), 'Алина не хочет смотреть «X»');
  assert.equal(eventText({ type: 'match', who: 'alina', title: 'X' }), '💞 Совпадение! Оба хотите «X»');
  assert.equal(eventText({ type: 'react', who: 'alina', emoji: '😂', target: 'maksim', title: 'X' }), 'Алина отреагировала 😂 на отзыв Максима о «X»');

  assert.equal(unreadCount(feed, 'maksim', Date.parse('2026-10-09T00:00:00Z')), 2, 'only the other person’s events count');
  assert.equal(unreadCount(feed, 'maksim', Date.parse('2026-10-11T00:00:00Z')), 1);
  assert.equal(unreadCount(feed, null, 0), 0);
});

test('reactions helpers', () => {
  const m = { reactions: { maksim: { alina: { '😂': true, '❤️': false, '🔥': true }, maksim: { '👍': true } }, alina: {} } };
  assert.deepEqual(reactionsOn(m, 'maksim'), [{ who: 'alina', emoji: '😂' }, { who: 'alina', emoji: '🔥' }], 'own reactions on own review are ignored');
  assert.equal(hasReaction(m, 'maksim', 'alina', '😂'), true);
  assert.equal(hasReaction(m, 'maksim', 'alina', '❤️'), false);
  assert.deepEqual(reactionsOn(m, 'alina'), []);
});

test('details/log/reactions survive the round trip; junk is normalized', () => {
  const m = emptyMovie({ title: 'X', details: { runtime: 100, genres: ['драма'] }, log: { a: { type: 'watch', who: 'alina', t: 5 } }, reactions: { maksim: { alina: { '😂': true } } } });
  const back = parseIssue({ number: 1, title: 'X', body: serializeBody(m), state: 'open' });
  assert.deepEqual(back.details, { runtime: 100, genres: ['драма'] });
  assert.deepEqual(back.log, { a: { type: 'watch', who: 'alina', t: 5 } });
  assert.deepEqual(back.reactions, { maksim: { alina: { '😂': true } }, alina: {} });
  const junk = parseIssue({ number: 2, title: 'Y', body: '<!-- cinemagoal:data\n{"details":"x","log":[1,2],"reactions":5}\n-->', state: 'open' });
  assert.deepEqual([junk.details, junk.log, junk.reactions], [null, {}, { maksim: {}, alina: {} }]);
});

test('two people logging events at the same moment keep both events', async () => {
  const gh = new FakeGitHub();
  const opts = { owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl: gh.fetch, verifyDelayMs: 5 };
  const a = createClient(opts);
  const b = createClient(opts);
  const m = await a.create({ title: 'Терминал' });
  const t = Date.now();
  await Promise.all([
    a.update(1, { ratings: { maksim: 8 }, ...logPatch(m, { type: 'rate', who: 'maksim', t, value: 8 }) }),
    b.update(1, { reactions: { maksim: { alina: { '❤️': true } } }, ...logPatch(m, { type: 'react', who: 'alina', t, emoji: '❤️', target: 'maksim' }) }),
  ]);
  await new Promise((r) => setTimeout(r, 80));
  const final = await a.get(1);
  assert.deepEqual(Object.values(final.log).map((e) => e.type).sort(), ['rate', 'react']);
  assert.equal(final.ratings.maksim, 8);
  assert.equal(final.reactions.maksim.alina['❤️'], true);
});

test('day labels', () => {
  const now = new Date(2026, 9, 12, 15, 0).getTime();
  assert.equal(dayLabel(new Date(2026, 9, 12, 1, 0).getTime(), now), 'Сегодня');
  assert.equal(dayLabel(new Date(2026, 9, 11, 23, 0).getTime(), now), 'Вчера');
  assert.equal(dayLabel(new Date(2026, 9, 1, 12, 0).getTime(), now), '1 октября');
  assert.equal(dayLabel(new Date(2025, 9, 1, 12, 0).getTime(), now), '1 октября 2025 г.');
});

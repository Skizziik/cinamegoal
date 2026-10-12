import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vote, isMatch, isRejected, otherPerson, voteScore, rouletteCandidates, pickRandom, buildReel, swipeQueue,
} from '../../js/pick.js';
import { emptyMovie, parseIssue, serializeBody, createClient } from '../../js/store.js';
import { FakeGitHub } from '../fake-github.js';

let n = 0;
const mk = (fields) => ({ ...emptyMovie(fields), id: ++n, deleted: false });
const seqRng = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('votes survive serialize → parse and garbage is normalized to null', () => {
  const m = emptyMovie({ title: 'Сплит', votes: { maksim: true, alina: false } });
  const back = parseIssue({ number: 1, title: 'Сплит', body: serializeBody(m), state: 'open' });
  assert.deepEqual(back.votes, { maksim: true, alina: false });
  const old = parseIssue({ number: 2, title: 'Старый', body: serializeBody({ ...emptyMovie({ title: 'Старый' }), votes: undefined }), state: 'open' });
  assert.deepEqual(old.votes, { maksim: null, alina: null }, 'movies saved before voting existed');
  const junk = parseIssue({ number: 3, title: 'x', body: '<!-- cinemagoal:data\n{"votes":{"maksim":"yes","alina":1}}\n-->', state: 'open' });
  assert.deepEqual(junk.votes, { maksim: null, alina: null });
});

test('match / reject / score', () => {
  const both = mk({ votes: { maksim: true, alina: true } });
  const one = mk({ votes: { maksim: true, alina: null } });
  const none = mk({});
  const split = mk({ votes: { maksim: true, alina: false } });
  const nope = mk({ votes: { maksim: false, alina: false } });
  assert.equal(isMatch(both), true);
  assert.equal(isMatch(one), false);
  assert.equal(isRejected(split), true);
  assert.equal(isRejected(none), false);
  assert.deepEqual([nope, split, none, both, one].sort((a, b) => voteScore(b) - voteScore(a)).map(voteScore), [2, 1, 0, 0, -2]);
  assert.equal(vote(one, 'alina'), null);
  assert.equal(otherPerson('maksim'), 'alina');
  assert.equal(otherPerson('alina'), 'maksim');
});

test('roulette candidates per mode', () => {
  const a = mk({ title: 'A', addedBy: 'maksim', votes: { maksim: true, alina: true } });
  const b = mk({ title: 'B', addedBy: 'alina' });
  const c = mk({ title: 'C', addedBy: 'alina', votes: { maksim: false, alina: true } });
  const watched = mk({ title: 'W', watched: true, votes: { maksim: true, alina: true } });
  const deleted = { ...mk({ title: 'D' }), deleted: true };
  const pending = { ...mk({ title: 'P' }), id: 'tmp-1' };
  const all = [a, b, c, watched, deleted, pending];
  const titles = (mode) => rouletteCandidates(all, mode).map((m) => m.title);
  assert.deepEqual(titles('all'), ['A', 'B'], 'rejected, watched, deleted and unsaved movies are skipped');
  assert.deepEqual(titles('match'), ['A']);
  assert.deepEqual(titles('alina'), ['B']);
  assert.deepEqual(titles('maksim'), ['A']);
});

test('pickRandom and reel placement', () => {
  const list = [mk({ title: '1' }), mk({ title: '2' }), mk({ title: '3' })];
  assert.equal(pickRandom([], Math.random), null);
  assert.equal(pickRandom(list, () => 0).title, '1');
  assert.equal(pickRandom(list, () => 0.99999).title, '3');
  assert.equal(pickRandom(list, () => 1).title, '3', 'rng() === 1 never overflows');

  const winner = list[1];
  const { items, index } = buildReel(list, winner, { length: 20, tail: 3, rng: seqRng(0, 0, 0.5, 0.9) });
  assert.equal(items.length, 20);
  assert.equal(index, 16);
  assert.equal(items[index], winner);
  for (let i = 1; i < items.length; i++) assert.notEqual(items[i].id, items[i - 1].id, `no repeats at ${i}`);
  // the rng that always picks the winner still yields different neighbours around it
  for (const rng of [() => 0.4, seqRng(0.4, 0.4, 0, 0.4)]) {
    const r = buildReel(list, winner, { length: 12, tail: 3, rng });
    assert.notEqual(r.items[r.index - 1].id, winner.id);
    assert.notEqual(r.items[r.index + 1].id, winner.id);
  }
  assert.deepEqual(buildReel([], null), { items: [], index: -1 });
  const solo = buildReel([winner], winner, { length: 5, tail: 1 });
  assert.equal(solo.items[solo.index], winner);
});

test('swipe queue: only my unvoted to-watch movies, newest first', () => {
  const old = mk({ title: 'old', addedAt: '2026-01-01T00:00:00Z' });
  const fresh = mk({ title: 'fresh', addedAt: '2026-10-01T00:00:00Z' });
  const votedByMe = mk({ title: 'mine', addedAt: '2026-03-01T00:00:00Z', votes: { maksim: false, alina: null } });
  const votedByHer = mk({ title: 'hers', addedAt: '2026-05-01T00:00:00Z', votes: { maksim: null, alina: true } });
  const watched = mk({ title: 'w', watched: true });
  const q = swipeQueue([old, fresh, votedByMe, votedByHer, watched], 'maksim').map((m) => m.title);
  assert.deepEqual(q, ['fresh', 'hers', 'old']);
  assert.deepEqual(swipeQueue([old, fresh, votedByMe, votedByHer, watched], 'alina').map((m) => m.title), ['fresh', 'mine', 'old']);
});

test('two people voting at the same moment both keep their vote', async () => {
  const gh = new FakeGitHub();
  const opts = { owner: 'Skizziik', repo: 'cinamegoal', token: gh.token, fetchImpl: gh.fetch, verifyDelayMs: 5 };
  const a = createClient(opts);
  const b = createClient(opts);
  await a.create({ title: 'Стекло' });
  await Promise.all([a.update(1, { votes: { maksim: true } }), b.update(1, { votes: { alina: true } })]);
  await new Promise((r) => setTimeout(r, 80));
  const final = await a.get(1);
  assert.deepEqual(final.votes, { maksim: true, alina: true });
  assert.equal(isMatch(final), true);
});

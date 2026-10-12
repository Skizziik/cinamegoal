// Pure logic for choosing tonight's movie: votes, matches, roulette, swipe queue.
import { PERSON_IDS } from './store.js';

export const vote = (m, p) => m?.votes?.[p] ?? null;
export const isMatch = (m) => PERSON_IDS.every((p) => vote(m, p) === true);
export const isRejected = (m) => PERSON_IDS.some((p) => vote(m, p) === false);
export const otherPerson = (me) => PERSON_IDS.find((p) => p !== me);

// +1 per "хочу", -1 per "не хочу": both want → top, anyone against → bottom.
export function voteScore(m) {
  return PERSON_IDS.reduce((s, p) => s + (vote(m, p) === true ? 1 : vote(m, p) === false ? -1 : 0), 0);
}

const toWatch = (movies) => movies.filter((m) => !m.deleted && !m.watched && typeof m.id === 'number');

export const ROULETTE_MODES = ['all', 'match', ...PERSON_IDS];

// "all" skips movies someone said "не хочу" to; "match" = both said "хочу".
export function rouletteCandidates(movies, mode = 'all') {
  const pool = toWatch(movies);
  if (mode === 'match') return pool.filter(isMatch);
  const ok = pool.filter((m) => !isRejected(m));
  return PERSON_IDS.includes(mode) ? ok.filter((m) => m.addedBy === mode) : ok;
}

export function pickRandom(list, rng = Math.random) {
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

// Strip of posters for the spin animation; the winner sits near the end so the
// reel decelerates onto it with a few posters still visible after it.
export function buildReel(candidates, winner, { length = 30, tail = 3, rng = Math.random } = {}) {
  if (!candidates.length || !winner) return { items: [], index: -1 };
  const items = [];
  for (let i = 0; i < length; i++) {
    let m = pickRandom(candidates, rng);
    // avoid the same poster twice in a row when there is a choice
    if (candidates.length > 1 && items.length && items[items.length - 1].id === m.id) {
      m = candidates[(candidates.indexOf(m) + 1) % candidates.length];
    }
    items.push(m);
  }
  const index = length - 1 - tail;
  items[index] = winner;
  // keep the winner's neighbours different from it, so it reads as a clear stop
  if (candidates.length > 1) {
    const others = candidates.filter((m) => m.id !== winner.id);
    for (const i of [index - 1, index + 1]) {
      if (items[i]?.id === winner.id) {
        items[i] = others.find((m) => m.id !== items[i - 1]?.id && m.id !== items[i + 1]?.id) || others[0];
      }
    }
  }
  return { items, index };
}

// Movies I haven't voted on yet, newest first.
export function swipeQueue(movies, me) {
  return toWatch(movies)
    .filter((m) => vote(m, me) === null)
    .sort((a, b) => (Date.parse(b.addedAt) || 0) - (Date.parse(a.addedAt) || 0));
}

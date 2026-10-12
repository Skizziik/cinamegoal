// Activity feed ("Алина добавила «Сплит»") and reactions on reviews.
// Events live in each movie's `log` object keyed by a unique id, so two people
// writing events at once add different keys and never overwrite each other.
import { PEOPLE } from './store.js';

export const REACTIONS = ['😂', '❤️', '🤯', '👍', '😢', '🔥'];
export const LOG_LIMIT = 60;
const BUCKET_MS = 10 * 60 * 1000;
// Re-rating or editing a review within 10 minutes updates the same event instead of piling up new ones.
const COALESCE = new Set(['rate', 'review']);

let counter = 0;
export function eventKey(ev) {
  if (COALESCE.has(ev.type)) return `${ev.type}-${ev.who}-${Math.floor(ev.t / BUCKET_MS)}`;
  counter = (counter + 1) % 1000;
  return `${ev.type}-${ev.who}-${ev.t.toString(36)}-${counter}${Math.random().toString(36).slice(2, 6)}`;
}

// Patch fragment that appends `ev` to the movie's log and drops the oldest
// entries (set to null) beyond LOG_LIMIT.
export function logPatch(movie, ev) {
  const log = { [eventKey(ev)]: ev };
  const entries = Object.entries(movie?.log || {}).filter(([, e]) => e && Number.isFinite(e.t));
  const overflow = entries.length + 1 - LOG_LIMIT;
  if (overflow > 0) {
    entries.sort((a, b) => a[1].t - b[1].t).slice(0, overflow).forEach(([k]) => { log[k] = null; });
  }
  return { log };
}

export function reactionsOn(movie, owner) {
  // [{ who, emoji }] reactions others left on `owner`'s review
  const out = [];
  for (const [who, set] of Object.entries(movie?.reactions?.[owner] || {})) {
    if (who === owner || !set) continue;
    for (const emoji of REACTIONS) if (set[emoji] === true) out.push({ who, emoji });
  }
  return out;
}

export const hasReaction = (movie, owner, who, emoji) => movie?.reactions?.[owner]?.[who]?.[emoji] === true;

const g = (who, masc, fem) => (who === 'alina' ? fem : masc);
const name = (who) => PEOPLE[who]?.name || 'Кто-то';

export function eventText(ev) {
  const t = `«${ev.title}»`;
  const n = name(ev.who);
  switch (ev.type) {
    case 'add': return `${n} ${g(ev.who, 'добавил', 'добавила')} ${t}`;
    case 'watch': return `${n} ${g(ev.who, 'отметил', 'отметила')} ${t} просмотренным`;
    case 'rate': return `${n} ${g(ev.who, 'поставил', 'поставила')} ${ev.value}/10 фильму ${t}`;
    case 'review': return `${n} ${g(ev.who, 'написал', 'написала')} отзыв о ${t}`;
    case 'vote': return ev.value ? `${n} хочет посмотреть ${t}` : `${n} не хочет смотреть ${t}`;
    case 'match': return `💞 Совпадение! Оба хотите ${t}`;
    case 'react': return `${n} ${g(ev.who, 'отреагировал', 'отреагировала')} ${ev.emoji} на отзыв ${ev.target === 'alina' ? 'Алины' : 'Максима'} о ${t}`;
    default: return `${n}: ${t}`;
  }
}

// Every event across all movies, newest first. "Added" events come from addedAt/addedBy,
// so movies added before the feed existed show up too.
export function buildFeed(movies, { limit = 150 } = {}) {
  const events = [];
  for (const m of movies) {
    if (m.deleted || typeof m.id !== 'number') continue;
    const t0 = Date.parse(m.addedAt);
    if (Number.isFinite(t0)) events.push({ type: 'add', who: m.addedBy, t: t0, movieId: m.id, title: m.title, key: `add-${m.id}` });
    for (const [key, e] of Object.entries(m.log || {})) {
      if (!e || !Number.isFinite(e.t) || !e.type) continue;
      events.push({ ...e, movieId: m.id, title: m.title, key: `${m.id}:${key}` });
    }
  }
  return events.sort((a, b) => b.t - a.t).slice(0, limit);
}

export function unreadCount(events, me, seenAt) {
  if (!me) return 0;
  return events.filter((e) => e.who !== me && e.t > seenAt).length;
}

export function dayLabel(t, now = Date.now()) {
  const d = new Date(t);
  const today = new Date(now);
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

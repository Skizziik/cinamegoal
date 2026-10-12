import { CONFIG, getToken, setToken, takeTokenFromHash, getPollMs } from './config.js';
import {
  PEOPLE, PERSON_IDS, createClient, emptyMovie, deepMerge, averageRating, normalizeTitle, clampRating,
} from './store.js';
import { searchFilms } from './posters.js';
import {
  vote, isMatch, otherPerson, voteScore, rouletteCandidates, pickRandom, buildReel, swipeQueue,
} from './pick.js';

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const haptic = () => { try { navigator.vibrate?.(8); } catch { /* ignore */ } };
const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
};
function fmtDate(iso, withYear) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(withYear || !sameYear ? { year: 'numeric' } : {}) });
}
const cssUrl = (u) => esc(String(u).replace(/['"()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`));
// Only touch the DOM when markup really changed, so polling never swaps a button mid-tap.
function setHTML(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}
function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="M6.7 5.3 12 10.6l5.3-5.3a1 1 0 1 1 1.4 1.4L13.4 12l5.3 5.3a1 1 0 0 1-1.4 1.4L12 13.4l-5.3 5.3a1 1 0 0 1-1.4-1.4l5.3-5.3-5.3-5.3a1 1 0 0 1 1.4-1.4Z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9.5 16.2 5.3 12a1 1 0 0 0-1.4 1.4l4.9 4.9a1 1 0 0 0 1.4 0L20.1 8.4A1 1 0 0 0 18.7 7l-9.2 9.2Z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M12 5c5 0 8.7 3.6 10 7-1.3 3.4-5 7-10 7S3.3 15.4 2 12c1.3-3.4 5-7 10-7Zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg>',
};

function posterHTML(m, { small = false } = {}) {
  const h = hue(m.title || '?');
  const fallback = `<div class="poster-fallback" style="background:linear-gradient(160deg,hsl(${h} 65% 42%),hsl(${(h + 50) % 360} 70% 16%))">${esc(m.title || 'Без названия')}${!small && m.year ? `<small>${esc(m.year)}</small>` : ''}</div>`;
  if (!m.poster) return fallback;
  return `${fallback}<img src="${esc(m.poster)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-poster>`;
}
// Hide broken poster images so the gradient fallback underneath shows.
document.addEventListener('error', (e) => {
  if (e.target?.matches?.('img[data-poster]')) e.target.remove();
}, true);

/* ---------------- state ---------------- */
takeTokenFromHash();
const state = {
  me: PEOPLE[store.get('cg_me')] ? store.get('cg_me') : null,
  movies: new Map(),
  tab: store.get('cg_tab', 'towatch'),
  filter: 'all',
  query: '',
  sort: store.get('cg_sort', 'match'),
  token: getToken(),
  loaded: false,
  pending: new Map(),
  sheet: null,
  error: null,
};
let client = makeClient();
function makeClient() {
  return createClient({
    owner: CONFIG.owner, repo: CONFIG.repo, label: CONFIG.label, token: state.token,
    onRepair: () => refresh({ force: true }),
  });
}
const readOnly = () => !state.token;

try {
  const cached = JSON.parse(store.get('cg_cache', '[]'));
  for (const m of cached) state.movies.set(m.id, m);
  if (cached.length) state.loaded = true;
} catch { /* ignore */ }

function saveCache() {
  const list = [...state.movies.values()].filter((m) => typeof m.id === 'number');
  store.set('cg_cache', JSON.stringify(list));
}

/* ---------------- sync ---------------- */
function setSync(kind, text) {
  const el = $('#sync');
  const labels = { ok: 'Синхронизировано', saving: 'Сохранение…', loading: 'Загрузка…', error: 'Нет связи', readonly: 'Только просмотр' };
  if (kind === 'ok' && readOnly()) kind = 'readonly';
  if (kind === 'ok' && state.writeDenied) { kind = 'error'; text = 'Нет права на запись'; }
  if (kind === 'ok' && state.pending.size) kind = 'saving';
  el.dataset.state = kind;
  $('.sync-text', el).textContent = text || labels[kind];
}

let refreshing = null;
let refreshingClient = null;
async function refresh({ force = false } = {}) {
  if (refreshing && refreshingClient === client) return refreshing;
  // A response from a client made with an old key must not affect the new one
  // (e.g. a late 401 for a wrong key wiping the correct key typed right after).
  const c = client;
  refreshingClient = c;
  const p = (async () => {
    try {
      const r = await c.list({ force });
      if (c !== client) return;
      if (r.changed) applyServerList(r.movies);
      setSync('ok');
    } catch (e) {
      if (c === client) handleError(e);
    } finally {
      if (refreshing === p) refreshing = null;
    }
  })();
  refreshing = p;
  return p;
}

function applyServerList(list) {
  const next = new Map();
  for (const m of list) {
    // Keep our optimistic copy while a write for this movie is still in flight.
    next.set(m.id, state.pending.get(m.id) && state.movies.has(m.id) ? state.movies.get(m.id) : m);
  }
  for (const [id, m] of state.movies) if (typeof id === 'string') next.set(id, m);
  state.movies = next;
  state.loaded = true;
  saveCache();
  render();
  updateOpenSheet();
}

const isRateLimit = (e) => e?.status === 429 || /rate limit/i.test(e?.message || '');
const noWriteAccess = (e) => (e?.status === 403 || e?.status === 404) && !isRateLimit(e);

// Human-readable reason for a failed write, shown in a toast.
function errorText(e, action) {
  if (!e?.status) return `${action}: нет связи с GitHub — проверь интернет`;
  if (e.status === 401) return `${action}: ключ доступа недействителен`;
  if (isRateLimit(e)) return `${action}: GitHub ограничил запросы, попробуй через минуту`;
  if (noWriteAccess(e)) return `${action}: у ключа нет права на запись. В настройках токена нужно Issues → «Read and write»`;
  return `${action}: ошибка GitHub ${e.status} (${e.message})`;
}

function handleError(e) {
  console.warn(e);
  if (e?.status === 401 && state.token) {
    setToken('');
    state.token = '';
    client = makeClient();
    state.error = 'badkey';
    render();
    refresh({ force: true });
    return;
  }
  if (isRateLimit(e)) {
    setSync('error', 'Лимит запросов, подожди');
  } else if (noWriteAccess(e)) {
    state.writeDenied = true;
    setSync('error', 'Нет права на запись');
  } else {
    setSync('error');
  }
}

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(async () => {
    await refresh();
    schedulePoll();
  }, getPollMs(readOnly()));
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refresh(); schedulePoll(); } else clearTimeout(pollTimer);
});
window.addEventListener('focus', () => refresh());
window.addEventListener('online', () => refresh());

/* ---------------- writes ---------------- */
const queues = new Map();
function enqueue(id, fn) {
  state.pending.set(id, (state.pending.get(id) || 0) + 1);
  setSync('saving');
  const prev = queues.get(id) || Promise.resolve();
  const p = prev.catch(() => {}).then(fn).finally(() => {
    const n = state.pending.get(id) - 1;
    if (n > 0) state.pending.set(id, n); else state.pending.delete(id);
    if (queues.get(id) === p) queues.delete(id);
    if (!state.pending.size) setSync('ok');
  });
  queues.set(id, p);
  return p;
}

async function addMovie(fields) {
  const tmpId = `tmp-${Date.now()}`;
  state.movies.set(tmpId, { ...emptyMovie(fields), id: tmpId });
  render();
  try {
    const created = await enqueue(tmpId, () => client.create(fields));
    state.writeDenied = false;
    state.movies.delete(tmpId);
    state.movies.set(created.id, created);
    saveCache();
    render();
    return created;
  } catch (e) {
    state.movies.delete(tmpId);
    render();
    handleError(e);
    toast(errorText(e, 'Не удалось добавить'), null, null, 8000);
    return null;
  }
}

async function patchMovie(id, patch) {
  const local = state.movies.get(id);
  if (!local) return;
  state.movies.set(id, deepMerge(local, patch));
  render();
  updateOpenSheet();
  try {
    const fresh = await enqueue(id, () => client.update(id, patch));
    state.writeDenied = false;
    if (!state.pending.get(id)) {
      state.movies.set(id, fresh);
      saveCache();
      render();
      updateOpenSheet();
    }
    return true;
  } catch (e) {
    handleError(e);
    toast(errorText(e, 'Не сохранилось'), null, null, 8000);
    // A poll that started while the write was pending kept our optimistic copy,
    // so wait for it and then re-read the server state to undo the failed edit.
    if (refreshing) await refreshing;
    await refresh({ force: true });
    return false;
  }
}

async function deleteMovie(id) {
  const m = state.movies.get(id);
  if (!m) return;
  state.movies.set(id, { ...m, deleted: true });
  render();
  toast(`«${m.title}» удалён`, 'Вернуть', () => restoreMovie(id));
  try {
    await enqueue(id, () => client.remove(id));
  } catch (e) {
    state.movies.set(id, { ...m, deleted: false });
    render();
    handleError(e);
    toast(errorText(e, 'Не удалось удалить'), null, null, 8000);
  }
}

async function restoreMovie(id) {
  const m = state.movies.get(id);
  if (!m) return;
  state.movies.set(id, { ...m, deleted: false });
  render();
  try {
    await enqueue(id, () => client.restore(id));
  } catch (e) {
    handleError(e);
  }
}

/* ---------------- list rendering ---------------- */
function matches(m) {
  if (m.deleted) return false;
  if (state.filter !== 'all' && m.addedBy !== state.filter) return false;
  if (state.query) {
    const q = normalizeTitle(state.query);
    if (!normalizeTitle(`${m.title} ${m.original} ${m.year}`).includes(q)) return false;
  }
  return true;
}

function sortMovies(arr) {
  const by = state.sort;
  const date = (m) => Date.parse(state.tab === 'watched' ? (m.watchedAt || m.addedAt) : m.addedAt) || 0;
  const cmpTitle = (a, b) => a.title.localeCompare(b.title, 'ru');
  return arr.sort((a, b) => {
    if (by === 'az') return cmpTitle(a, b);
    if (by === 'rating') return (averageRating(b) ?? -1) - (averageRating(a) ?? -1) || cmpTitle(a, b);
    if (by === 'old') return date(a) - date(b);
    if (by === 'match' && state.tab === 'towatch') return voteScore(b) - voteScore(a) || date(b) - date(a);
    return date(b) - date(a);
  });
}

function cardHTML(m) {
  const avg = averageRating(m);
  const pending = typeof m.id === 'string';
  const who = PEOPLE[m.addedBy];
  let meta;
  if (m.watched) {
    const parts = PERSON_IDS.filter((p) => m.ratings[p]).map((p) => `${PEOPLE[p].short} ${m.ratings[p]}`);
    meta = parts.length ? parts.join(' · ') : 'Ещё без оценки';
  } else {
    meta = [m.year, who?.name].filter(Boolean).join(' · ');
  }
  return `<button type="button" class="card" data-id="${esc(m.id)}" ${pending ? 'disabled' : ''}>
    <div class="poster${pending ? ' pending' : ''}">${posterHTML(m)}
      ${who ? `<span class="badge who ${m.addedBy}" title="Добавил(а) ${esc(who.name)}">${who.short}</span>` : ''}
      ${m.watched && avg !== null ? `<span class="badge score">${ICON.star}${avg}</span>` : ''}
      ${!m.watched && isMatch(m) ? '<span class="badge match" title="Оба хотите посмотреть">💞</span>' : ''}
    </div>
    <div class="card-title">${esc(m.title)}</div>
    <div class="card-meta">${esc(meta)}</div>
  </button>`;
}

function render() {
  document.body.classList.toggle('read-only', readOnly());
  const all = [...state.movies.values()].filter((m) => !m.deleted);
  const watchedAll = all.filter((m) => m.watched);
  const avgs = watchedAll.map(averageRating).filter((a) => a !== null);
  const avgAll = avgs.length ? (avgs.reduce((a, b) => a + b, 0) / avgs.length).toFixed(1) : null;
  $('#stats').textContent = state.loaded
    ? [`${all.length} ${plural(all.length, ['фильм', 'фильма', 'фильмов'])}`,
      `${watchedAll.length} посмотрели`, avgAll && `средняя ${avgAll}`].filter(Boolean).join(' · ')
    : 'Загружаем список…';

  const visible = all.filter(matches);
  const towatch = visible.filter((m) => !m.watched);
  const watched = visible.filter((m) => m.watched);
  $('[data-count="towatch"]').textContent = towatch.length || '';
  $('[data-count="watched"]').textContent = watched.length || '';
  $$('#tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  $$('#filters [data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)));
  $('#sort').value = state.sort;
  $('#meBtn').innerHTML = state.me
    ? `<span class="avatar ${state.me}">${PEOPLE[state.me].short}</span>${PEOPLE[state.me].name}`
    : '<span class="avatar none">?</span>Кто ты?';

  renderBanner();
  renderQuick(all);

  const grid = $('#grid');
  const list = sortMovies(state.tab === 'watched' ? watched : towatch);
  if (!state.loaded) {
    setHTML(grid, Array.from({ length: 6 }, () => '<div class="card skeleton"><div class="poster"></div><div class="card-title"></div></div>').join(''));
    $('#empty').hidden = true;
    return;
  }
  setHTML(grid, list.map(cardHTML).join(''));
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = state.query || state.filter !== 'all'
      ? '<div class="big">🔍</div>Ничего не нашлось'
      : state.tab === 'watched'
        ? '<div class="big">🍿</div>Пока ничего не посмотрели.<br>Открой фильм и нажми «Посмотрели!»'
        : '<div class="big">🎬</div>Список пуст. Добавь первый фильм!';
  }
}

function renderQuick(all) {
  $('#quick').hidden = state.tab !== 'towatch' || !state.loaded || !all.some((m) => !m.watched);
  $('#swipeBtn').hidden = readOnly();
  const left = state.me ? swipeQueue(all, state.me).length : 0;
  const pill = $('#swipeCount');
  pill.hidden = !left;
  pill.textContent = left;
  $('#swipeHint').textContent = state.me && !left ? 'Всё проголосовано ✓' : 'Хочу / не хочу';
}

function renderBanner() {
  const b = $('#banner');
  if (!readOnly()) { b.hidden = true; b.dataset.mode = ''; return; }
  const mode = state.error === 'badkey' ? 'badkey' : 'ro';
  b.hidden = false;
  if (b.dataset.mode) {
    // Only swap the message: rebuilding the form would wipe a key being typed.
    if (b.dataset.mode !== mode) $('#bannerMsg').textContent = mode === 'badkey' ? 'Ключ доступа не подошёл.' : 'Режим просмотра.';
    b.dataset.mode = mode;
    return;
  }
  b.dataset.mode = mode;
  b.innerHTML = `<strong id="bannerMsg">${mode === 'badkey' ? 'Ключ доступа не подошёл.' : 'Режим просмотра.'}</strong>
    Чтобы добавлять и оценивать фильмы, открой ссылку-приглашение или вставь ключ:
    <form class="row" id="keyForm"><input class="input" id="keyInput" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button class="btn small" type="submit">Войти</button></form>`;
  $('#keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#keyInput').value.trim();
    if (!v) return;
    setToken(v);
    state.token = v;
    state.error = null;
    client = makeClient();
    render();
    await refresh({ force: true });
    schedulePoll();
  });
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(text, actionLabel, action, ms) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  t.hidden = false;
  if (actionLabel) $('button', t).onclick = () => { t.hidden = true; action(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || (actionLabel ? 6000 : 3000));
}

/* ---------------- sheets ---------------- */
function openSheet({ title, left = '', right = '', body = '', className = '', onClose }) {
  const root = $('#sheetRoot');
  if (state.sheet) teardownSheet(true);
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = `sheet ${className}`;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', title || '');
  sheet.innerHTML = `<div class="grabber"></div>
    <div class="sheet-head"><div class="left">${left}</div><h2>${esc(title || '')}</h2><div class="right">${right}</div></div>
    <div class="sheet-body">${body}</div>`;
  root.append(backdrop, sheet);
  document.body.classList.add('sheet-open');
  backdrop.addEventListener('click', () => closeSheet());
  enableDrag(sheet);
  if (!history.state?.sheet) history.pushState({ sheet: true }, '');
  state.sheet = { el: sheet, backdrop, onClose };
  return sheet;
}

function teardownSheet(immediate = false) {
  const s = state.sheet;
  if (!s) return;
  state.sheet = null;
  s.onClose?.();
  if (immediate) {
    s.el.remove();
    s.backdrop.remove();
  } else {
    s.el.classList.add('closing');
    s.backdrop.classList.add('closing');
    setTimeout(() => { s.el.remove(); s.backdrop.remove(); }, 280);
  }
  if (!state.sheet) document.body.classList.remove('sheet-open');
}

function closeSheet() {
  if (history.state?.sheet) history.back(); // popstate does the actual close
  else teardownSheet();
}
window.addEventListener('popstate', () => { if (state.sheet) teardownSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sheet) closeSheet(); });

function enableDrag(sheet) {
  const handle = [$('.grabber', sheet), $('.sheet-head', sheet)];
  let startY = null; let dy = 0; let t0 = 0;
  const onMove = (e) => {
    if (startY === null) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const onUp = () => {
    if (startY === null) return;
    const v = dy / Math.max(1, Date.now() - t0);
    startY = null;
    sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
    if (dy > 140 || v > 0.6) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(() => closeSheet(), 200);
    } else {
      sheet.style.transform = '';
      setTimeout(() => { sheet.style.transition = ''; }, 300);
    }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  handle.forEach((h) => h?.addEventListener('pointerdown', (e) => {
    if (window.innerWidth >= 700 || e.target.closest('button')) return;
    startY = e.clientY; dy = 0; t0 = Date.now();
    sheet.style.transition = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }));
}

function updateOpenSheet() {
  state.sheet?.update?.();
}

/* ---------------- who am I ---------------- */
function openMeSheet() {
  const invite = state.token ? `${location.origin}${location.pathname}#key=${encodeURIComponent(state.token)}` : '';
  const sheet = openSheet({
    title: 'Кто ты?',
    right: state.me ? `<button class="close-btn" data-close aria-label="Закрыть">${ICON.close}</button>` : '',
    body: `<p class="group-foot" style="margin:0 0 16px">Так сайт будет знать, кто добавляет фильмы и чья оценка — твоя.</p>
      <div class="seg-person">${PERSON_IDS.map((p) => `<button type="button" class="${p}" data-me="${p}" aria-pressed="${state.me === p}"><span class="avatar ${p}">${PEOPLE[p].short}</span>${PEOPLE[p].name}</button>`).join('')}</div>
      ${invite ? `<div class="group-label">Пригласить</div>
        <div class="actions" style="margin-bottom:22px"><button type="button" class="btn gray" data-invite>Отправить ссылку с доступом</button></div>
        <p class="group-foot" style="margin:-12px 16px 22px">По этой ссылке второй человек сможет добавлять и оценивать фильмы. Не публикуй её открыто.</p>
        <div class="actions"><button type="button" class="btn danger" data-logout>Выйти на этом устройстве</button></div>` : ''}`,
  });
  $('[data-close]', sheet)?.addEventListener('click', () => closeSheet());
  $$('[data-me]', sheet).forEach((b) => b.addEventListener('click', () => {
    state.me = b.dataset.me;
    store.set('cg_me', state.me);
    haptic();
    render();
    closeSheet();
  }));
  $('[data-invite]', sheet)?.addEventListener('click', async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Наше кино', text: 'Наш список фильмов 🎬', url: invite });
      else { await navigator.clipboard.writeText(invite); toast('Ссылка скопирована'); }
    } catch { /* cancelled */ }
  });
  $('[data-logout]', sheet)?.addEventListener('click', () => {
    if (!confirm('Убрать ключ доступа с этого устройства? Сайт останется в режиме просмотра.')) return;
    setToken('');
    state.token = '';
    client = makeClient();
    closeSheet();
    render();
    refresh({ force: true });
  });
}

/* ---------------- add / edit ---------------- */
function openMovieForm(existing = null) {
  if (readOnly()) return;
  const m = existing || { title: '', year: '', poster: '', original: '', note: '', addedBy: state.me || 'maksim' };
  const sheet = openSheet({
    title: existing ? 'Изменить' : 'Новый фильм',
    left: '<button type="button" class="text-btn" data-cancel>Отмена</button>',
    right: `<button type="button" class="text-btn bold" data-save disabled>${existing ? 'Готово' : 'Добавить'}</button>`,
    body: `<form id="movieForm" autocomplete="off">
      <div class="group">
        <input class="field" name="title" placeholder="Название фильма" value="${esc(m.title)}" enterkeyhint="done" required>
        <input class="field" name="year" placeholder="Год (необязательно)" value="${esc(m.year)}" inputmode="numeric" maxlength="4">
      </div>
      <p class="warn" data-dup hidden>Такой фильм уже есть в списке</p>
      <div class="group-label">Постер</div>
      <div class="picker" data-picker></div>
      <div class="group-label">Кто добавил</div>
      <div class="seg-person">${PERSON_IDS.map((p) => `<button type="button" class="${p}" data-who="${p}" aria-pressed="${m.addedBy === p}"><span class="avatar ${p}">${PEOPLE[p].short}</span>${PEOPLE[p].name}</button>`).join('')}</div>
      <div class="group"><textarea class="field" name="note" rows="3" placeholder="Заметка: кто посоветовал, почему хотим посмотреть…">${esc(m.note)}</textarea></div>
      ${existing ? '<div class="actions"><button type="button" class="btn danger" data-delete>Удалить фильм</button></div>' : ''}
    </form>`,
  });
  const form = $('#movieForm', sheet);
  const titleIn = form.elements.title;
  const yearIn = form.elements.year;
  const saveBtn = $('[data-save]', sheet);
  const picker = $('[data-picker]', sheet);
  let addedBy = m.addedBy;
  let chosen = m.poster ? { poster: m.poster, title: m.title, year: m.year, original: m.original, current: true } : null;
  let options = chosen ? [chosen] : [];
  let status = '';
  let yearAuto = !m.year;

  const renderPicker = () => {
    const tiles = options.map((o, i) => `<button type="button" class="pick" data-pick="${i}" aria-pressed="${chosen === o}">
        <div class="poster">${posterHTML({ title: o.title, poster: o.poster }, { small: true })}</div>
        <div class="pick-title">${esc(o.current ? 'Текущий' : o.title)}</div><div class="pick-meta">${esc(o.year || '')}</div></button>`);
    tiles.push(`<button type="button" class="pick" data-pick="none" aria-pressed="${chosen === null}">
        <div class="poster">${posterHTML({ title: titleIn.value.trim() || 'Без постера' }, { small: true })}</div>
        <div class="pick-title">Без постера</div><div class="pick-meta">&nbsp;</div></button>`);
    picker.innerHTML = tiles.join('') + (status ? `<div class="picker-status">${esc(status)}</div>` : '');
  };
  picker.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    haptic();
    chosen = b.dataset.pick === 'none' ? null : options[Number(b.dataset.pick)];
    if (chosen?.year && (yearAuto || !yearIn.value)) { yearIn.value = chosen.year; yearAuto = true; }
    renderPicker();
  });

  let searchCtl = null; let searchTimer = null;
  const runSearch = () => {
    clearTimeout(searchTimer);
    const q = titleIn.value.trim();
    if (q.length < 2) { options = options.filter((o) => o.current); status = ''; renderPicker(); return; }
    searchTimer = setTimeout(async () => {
      searchCtl?.abort();
      searchCtl = new AbortController();
      status = 'Ищем постеры…';
      renderPicker();
      try {
        const res = await searchFilms(q, { signal: searchCtl.signal });
        const keep = options.filter((o) => o.current);
        options = [...keep, ...res.filter((r) => r.poster && !keep.some((k) => k.poster === r.poster))];
        status = options.length ? '' : 'Постеров не нашлось';
        if (!existing && !chosen && options[0] && normalizeTitle(options[0].title).startsWith(normalizeTitle(q).slice(0, 6))) {
          chosen = options[0];
          if (chosen.year && (yearAuto || !yearIn.value)) { yearIn.value = chosen.year; yearAuto = true; }
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        status = 'Поиск постеров недоступен';
      }
      renderPicker();
    }, 450);
  };

  const validate = () => {
    const t = titleIn.value.trim();
    const dup = t && [...state.movies.values()].some((x) => !x.deleted && x.id !== existing?.id && normalizeTitle(x.title) === normalizeTitle(t));
    $('[data-dup]', sheet).hidden = !dup;
    saveBtn.disabled = !t;
  };
  titleIn.addEventListener('input', () => { validate(); runSearch(); });
  yearIn.addEventListener('input', () => { yearAuto = false; });
  $$('[data-who]', sheet).forEach((b) => b.addEventListener('click', () => {
    addedBy = b.dataset.who;
    haptic();
    $$('[data-who]', sheet).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  $('[data-cancel]', sheet).addEventListener('click', () => closeSheet());
  $('[data-delete]', sheet)?.addEventListener('click', () => {
    if (confirm(`Удалить «${existing.title}» из списка?`)) deleteMovie(existing.id).then(() => {});
    closeSheet();
  });
  titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleIn.blur(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); saveBtn.click(); });

  saveBtn.addEventListener('click', async () => {
    const title = titleIn.value.trim();
    if (!title) return;
    const fields = {
      title,
      year: (yearIn.value.match(/\d{4}/) || [''])[0],
      poster: chosen?.poster || '',
      original: chosen ? chosen.original || '' : '',
      note: form.elements.note.value.trim(),
      addedBy,
    };
    if (chosen?.current) fields.original = existing.original;
    haptic();
    closeSheet();
    if (existing) {
      patchMovie(existing.id, fields);
    } else {
      fields.addedAt = new Date().toISOString();
      if (state.tab !== 'towatch') { state.tab = 'towatch'; store.set('cg_tab', state.tab); }
      await addMovie(fields);
    }
  });

  validate();
  renderPicker();
  if (existing) runSearch();
  if (!existing) setTimeout(() => titleIn.focus(), 350);
}

/* ---------------- votes ---------------- */
function voteStatus(p, v) {
  if (v === true) return 'хочет 👍';
  if (v === false) return 'не хочет 👎';
  return p === 'alina' ? 'ещё не решила' : 'ещё не решил';
}

function votesHTML(m, ro) {
  const me = state.me;
  const rows = [];
  if (isMatch(m)) rows.push('<div class="match-banner">💞 Совпадение! Оба хотите посмотреть</div>');
  if (me && !ro) {
    const v = vote(m, me);
    rows.push(`<div class="vote-q">Хочешь посмотреть?</div>
      <div class="vote-btns">
        <button type="button" class="vote-btn yes" data-vote="yes" aria-pressed="${v === true}">👍 Хочу</button>
        <button type="button" class="vote-btn no" data-vote="no" aria-pressed="${v === false}">👎 Не хочу</button>
      </div>`);
  }
  const others = me && !ro ? [otherPerson(me)] : PERSON_IDS;
  rows.push(others.map((p) => `<div class="vote-other" data-vote-of="${p}"><span class="avatar ${p}">${PEOPLE[p].short}</span><span>${PEOPLE[p].name} ${voteStatus(p, vote(m, p))}</span></div>`).join(''));
  return rows.join('');
}

// Sets (or clears, when tapped again) my vote and celebrates a fresh match.
function toggleVote(id, want) {
  if (!state.me) { openMeSheet(); return; }
  const m = state.movies.get(id);
  if (!m) return;
  const next = vote(m, state.me) === want ? null : want;
  const otherWants = vote(m, otherPerson(state.me)) === true;
  patchMovie(id, { votes: { [state.me]: next } });
  if (next === true && otherWants) toast(`💞 Совпадение! Оба хотите «${m.title}»`);
}

const addedByText = (m) => {
  const who = PEOPLE[m.addedBy];
  return who ? `добавил${m.addedBy === 'alina' ? 'а' : ''} ${who.name}` : '';
};

/* ---------------- roulette ---------------- */
const ROULETTE_LABELS = { all: 'Все', match: '💞 Совпадения', maksim: 'От Максима', alina: 'От Алины' };

function openRoulette() {
  let mode = store.get('cg_roulette', 'all');
  if (!ROULETTE_LABELS[mode]) mode = 'all';
  let spinning = false;
  const sheet = openSheet({
    title: 'Что смотрим?',
    className: 'roulette-sheet',
    right: `<button class="close-btn" data-close aria-label="Закрыть">${ICON.close}</button>`,
    body: `<div class="chips roulette-modes">${Object.entries(ROULETTE_LABELS).map(([k, v]) => `<button type="button" class="chip" data-mode="${k}" aria-pressed="${k === mode}">${v}</button>`).join('')}</div>
      <div class="reel-wrap" data-wrap><div class="reel" data-reel></div><div class="reel-marker" aria-hidden="true"></div></div>
      <div class="roulette-result" data-result aria-live="polite"></div>
      <div class="actions"><button type="button" class="btn" data-spin>🎲 Крутить</button></div>
      <p class="roulette-note" data-note></p>`,
  });
  const reel = $('[data-reel]', sheet);
  const wrap = $('[data-wrap]', sheet);
  const result = $('[data-result]', sheet);
  const note = $('[data-note]', sheet);
  const spinBtn = $('[data-spin]', sheet);
  const tile = (m) => `<div class="reel-item" data-reel-id="${m.id}"><div class="poster">${posterHTML(m, { small: true })}</div></div>`;
  const candidates = () => rouletteCandidates([...state.movies.values()], mode);

  const showIdle = () => {
    const list = candidates();
    reel.style.transition = 'none';
    reel.style.transform = 'translateX(0)';
    reel.innerHTML = list.slice(0, 12).map(tile).join('');
    result.innerHTML = '';
    spinBtn.disabled = !list.length;
    spinBtn.textContent = '🎲 Крутить';
    note.textContent = list.length
      ? `Выбираем из ${list.length} ${plural(list.length, ['фильма', 'фильмов', 'фильмов'])}${mode === 'all' ? ' · без тех, что кто-то отклонил' : ''}`
      : mode === 'match' ? 'Пока нет совпадений — проголосуйте в «Свайпах» 💘' : 'Тут пока пусто';
  };

  const spin = () => {
    const list = candidates();
    if (spinning || !list.length) return;
    spinning = true;
    haptic();
    const winner = pickRandom(list);
    const { items, index } = buildReel(list, winner);
    result.innerHTML = '';
    spinBtn.disabled = true;
    reel.style.transition = 'none';
    reel.style.transform = 'translateX(0)';
    reel.innerHTML = items.map(tile).join('');
    const item = reel.children[index];
    const offset = item.offsetLeft + item.offsetWidth / 2 - wrap.clientWidth / 2;
    void reel.offsetWidth; // commit the reset so the spin always starts from the left
    const ms = Number(store.get('cg_spin_ms', '')) || 3600;
    reel.style.transition = `transform ${ms}ms cubic-bezier(0.12, 0.8, 0.14, 1)`;
    reel.style.transform = `translateX(${-offset}px)`;
    let done = false;
    const finish = () => {
      if (done || state.sheet?.el !== sheet) return;
      done = true;
      spinning = false;
      item.classList.add('win');
      haptic();
      result.innerHTML = `<div class="win-title">${esc(winner.title)}</div>
        <div class="win-meta">${esc([winner.year, addedByText(winner)].filter(Boolean).join(' · '))}${isMatch(winner) ? ' · 💞' : ''}</div>
        <button type="button" class="btn success" data-open="${winner.id}">🍿 Смотрим!</button>`;
      spinBtn.disabled = false;
      spinBtn.textContent = '🎲 Ещё раз';
    };
    reel.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, ms + 300);
  };

  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-close]')) closeSheet();
    else if (t.matches('[data-spin]')) spin();
    else if (t.matches('[data-open]')) openDetail(Number(t.dataset.open));
    else if (t.matches('[data-mode]') && !spinning) {
      mode = t.dataset.mode;
      store.set('cg_roulette', mode);
      $$('[data-mode]', sheet).forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      showIdle();
    }
  });
  showIdle();
}

/* ---------------- swipes ---------------- */
function openSwipe() {
  if (readOnly()) return;
  if (!state.me) { openMeSheet(); return; }
  const me = state.me;
  const other = otherPerson(me);
  const queue = swipeQueue([...state.movies.values()], me);
  const history = [];
  let index = 0;
  let matches = 0;
  const sheet = openSheet({
    title: 'Свайпы',
    className: 'swipe-sheet',
    right: `<button class="close-btn" data-close aria-label="Закрыть">${ICON.close}</button>`,
    body: `<div class="swipe-progress" data-progress></div>
      <div class="swipe-stack" data-stack></div>
      <div class="swipe-actions">
        <button type="button" class="swipe-btn undo" data-undo aria-label="Вернуть предыдущий">↺</button>
        <button type="button" class="swipe-btn no" data-no aria-label="Не хочу">✕</button>
        <button type="button" class="swipe-btn yes" data-yes aria-label="Хочу">♥</button>
      </div>
      <p class="swipe-hint">Вправо — хочу, влево — не хочу</p>
      <div class="match-overlay" data-match hidden></div>`,
  });
  const stack = $('[data-stack]', sheet);
  const overlay = $('[data-match]', sheet);

  const swipeCard = (queued, pos) => {
    const m = state.movies.get(queued.id) || queued; // freshest copy: the other person may have voted meanwhile
    return `<div class="swipe-card ${pos}" data-swipe-id="${m.id}">
      <div class="poster">${posterHTML(m)}</div>
      <div class="stamp yes">ХОЧУ</div><div class="stamp no">НЕТ</div>
      <div class="swipe-info">
        <div class="swipe-title">${esc(m.title)}</div>
        <div class="swipe-meta">${esc([m.year, addedByText(m)].filter(Boolean).join(' · '))}</div>
        ${vote(m, other) === true ? `<div class="swipe-tag">${PEOPLE[other].name} хочет 👍</div>` : ''}
        ${m.note ? `<div class="swipe-note">${esc(m.note)}</div>` : ''}
      </div>
    </div>`;
  };

  const renderStack = () => {
    const left = queue.length - index;
    $('[data-progress]', sheet).textContent = left ? `${index + 1} из ${queue.length}` : '';
    $('[data-undo]', sheet).disabled = !history.length;
    $('[data-no]', sheet).disabled = !left;
    $('[data-yes]', sheet).disabled = !left;
    if (!left) {
      stack.innerHTML = `<div class="swipe-done"><div class="big">🎉</div>
        <b>${queue.length ? 'Готово — ты проголосовал(а) за все фильмы' : 'Новых фильмов для голосования нет'}</b>
        <span>${matches ? `Новых совпадений: ${matches} 💞` : 'Совпадения появятся, когда второй тоже проголосует'}</span></div>`;
      return;
    }
    stack.innerHTML = [queue[index + 1] && swipeCard(queue[index + 1], 'next'), swipeCard(queue[index], 'top')].filter(Boolean).join('');
    attachDrag($('.swipe-card.top', stack));
  };

  const showMatch = (m) => {
    overlay.hidden = false;
    overlay.innerHTML = `<div class="match-card">
      <div class="match-title">Это мэтч! 💞</div>
      <div class="match-avatars"><span class="avatar maksim">М</span><span class="avatar alina">А</span></div>
      <div class="poster">${posterHTML(m, { small: true })}</div>
      <div class="match-sub">Вы оба хотите посмотреть «${esc(m.title)}»</div>
      <div class="actions"><button type="button" class="btn" data-continue>Продолжить</button>
        <button type="button" class="btn gray" data-open="${m.id}">Открыть фильм</button></div>
    </div>`;
  };

  const decide = (want) => {
    const m = queue[index];
    if (!m || !overlay.hidden) return;
    const card = $('.swipe-card.top', stack);
    haptic();
    const current = state.movies.get(m.id) || m;
    const isNewMatch = want && vote(current, other) === true;
    history.push({ id: m.id, prev: vote(current, me), match: isNewMatch });
    if (isNewMatch) matches++;
    patchMovie(m.id, { votes: { [me]: want } });
    index++;
    if (card) {
      card.style.transition = 'transform 0.35s ease-out, opacity 0.35s';
      card.style.transform = `translateX(${want ? 140 : -140}%) rotate(${want ? 18 : -18}deg)`;
      card.style.opacity = '0';
    }
    setTimeout(() => {
      if (state.sheet?.el !== sheet) return;
      renderStack();
      if (isNewMatch) showMatch(state.movies.get(m.id) || m);
    }, card ? 260 : 0);
  };

  function attachDrag(card) {
    if (!card) return;
    let x0 = null; let dx = 0; let t0 = 0;
    const move = (e) => {
      if (x0 === null) return;
      dx = e.clientX - x0;
      card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
      card.style.setProperty('--yes', Math.max(0, Math.min(1, dx / 100)));
      card.style.setProperty('--no', Math.max(0, Math.min(1, -dx / 100)));
    };
    const up = () => {
      if (x0 === null) return;
      x0 = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const speed = Math.abs(dx) / Math.max(1, Date.now() - t0);
      if (Math.abs(dx) > 100 || (Math.abs(dx) > 40 && speed > 0.5)) decide(dx > 0);
      else {
        card.style.transition = 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)';
        card.style.transform = '';
        card.style.setProperty('--yes', 0);
        card.style.setProperty('--no', 0);
      }
    };
    card.addEventListener('pointerdown', (e) => {
      x0 = e.clientX; dx = 0; t0 = Date.now();
      card.style.transition = 'none';
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  const onKey = (e) => {
    if (state.sheet?.el !== sheet) return;
    if (e.key === 'ArrowRight') decide(true);
    if (e.key === 'ArrowLeft') decide(false);
  };
  document.addEventListener('keydown', onKey);
  state.sheet.onClose = () => document.removeEventListener('keydown', onKey);

  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-close]')) closeSheet();
    else if (t.matches('[data-yes]')) decide(true);
    else if (t.matches('[data-no]')) decide(false);
    else if (t.matches('[data-continue]')) overlay.hidden = true;
    else if (t.matches('[data-open]')) openDetail(Number(t.dataset.open));
    else if (t.matches('[data-undo]')) {
      const last = history.pop();
      if (!last) return;
      index--;
      if (last.match) matches--;
      patchMovie(last.id, { votes: { [me]: last.prev } });
      renderStack();
    }
  });
  renderStack();
}

/* ---------------- detail ---------------- */
function openDetail(id) {
  const m0 = state.movies.get(id);
  if (!m0) return;
  const order = state.me ? [state.me, ...PERSON_IDS.filter((p) => p !== state.me)] : PERSON_IDS;
  const ro = readOnly();
  const sheet = openSheet({
    title: '',
    left: ro ? '' : '<button type="button" class="text-btn" data-edit>Изменить</button>',
    right: '<button type="button" class="text-btn bold" data-done>Готово</button>',
    body: `<div class="detail-hero" data-hero></div>
      <div class="note" data-note hidden></div>
      <div class="votes" data-votes></div>
      <div class="watch-row" data-watch></div>
      <div data-ratings hidden>
        <div class="avg" data-avg></div>
        ${order.map((p) => `<div class="person-card ${p}" data-person="${p}">
          <div class="person-head"><span class="avatar ${p}">${PEOPLE[p].short}</span>${PEOPLE[p].name}${p === state.me ? ' <span style="color:var(--label-3);font-weight:500">(ты)</span>' : ''}<span class="score" data-score></span></div>
          ${ro ? '' : `<div class="rating" role="radiogroup" aria-label="Оценка ${PEOPLE[p].name}">${Array.from({ length: 10 }, (_, i) => `<button type="button" role="radio" data-rate="${i + 1}">${i + 1}</button>`).join('')}</div>`}
          ${ro ? '<div class="review-ro" data-review-ro></div>' : `<textarea data-review rows="3" placeholder="${p === state.me ? 'Твои впечатления…' : `Впечатления ${p === 'alina' ? 'Алины' : 'Максима'}…`}"></textarea><div class="save-state" data-save-state></div>`}
        </div>`).join('')}
      </div>`,
    onClose: () => flushReviews(),
  });

  const dirty = {};
  const timers = {};
  const saveReview = async (p) => {
    clearTimeout(timers[p]);
    const ta = $(`[data-person="${p}"] [data-review]`, sheet);
    const st = $(`[data-person="${p}"] [data-save-state]`, sheet);
    const value = ta.value.trim();
    const cur = state.movies.get(id);
    if (!cur || (cur.reviews?.[p] || '') === value) { dirty[p] = false; return; }
    st.className = 'save-state'; st.textContent = 'Сохранение…';
    const ok = await patchMovie(id, { reviews: { [p]: value } });
    if (ta.value.trim() === value) dirty[p] = false;
    st.className = `save-state ${ok ? 'ok' : 'err'}`;
    st.textContent = ok ? 'Сохранено' : 'Ошибка сохранения';
  };
  function flushReviews() {
    for (const p of PERSON_IDS) if (dirty[p]) saveReview(p);
  }

  const update = () => {
    const m = state.movies.get(id);
    if (!m || m.deleted) { if (state.sheet?.el === sheet) closeSheet(); return; }
    const who = PEOPLE[m.addedBy];
    setHTML($('[data-hero]', sheet), `${m.poster ? `<div class="backdrop" style="background-image:url('${cssUrl(m.poster)}')"></div>` : ''}
      <div class="detail-top"><div class="poster">${posterHTML(m)}</div>
      <div class="detail-info"><h3 class="detail-title">${esc(m.title)}</h3>
        <div class="detail-sub">${esc([m.original && m.original !== m.title ? m.original : '', m.year].filter(Boolean).join(' · '))}</div>
        <div class="detail-added"><span class="avatar ${m.addedBy}">${who?.short || '?'}</span>${who ? `${m.addedBy === 'alina' ? 'Добавила' : 'Добавил'} ${who.name}` : 'Добавлен'} · ${fmtDate(m.addedAt)}</div>
      </div></div>`);
    const note = $('[data-note]', sheet);
    note.hidden = !m.note;
    note.textContent = m.note || '';
    setHTML($('[data-watch]', sheet), ro
      ? (m.watched ? `<div class="when">Посмотрели ${fmtDate(m.watchedAt, true)}</div>` : '<div class="when">Ещё не смотрели</div>')
      : m.watched
        ? `<button type="button" class="btn gray" data-unwatch>${ICON.eye}Вернуть в «Хотим посмотреть»</button><div class="when">Посмотрели ${fmtDate(m.watchedAt, true)}</div>`
        : `<button type="button" class="btn success" data-markwatched>${ICON.check}Посмотрели!</button>`);
    setHTML($('[data-votes]', sheet), m.watched ? '' : votesHTML(m, ro));
    $('[data-ratings]', sheet).hidden = !m.watched;
    const avg = averageRating(m);
    setHTML($('[data-avg]', sheet), avg !== null ? `<b>${avg}</b><span>общая оценка</span>` : '<span>Поставьте оценки от 1 до 10</span>');
    for (const p of PERSON_IDS) {
      const card = $(`[data-person="${p}"]`, sheet);
      const r = m.ratings?.[p];
      const score = $('[data-score]', card);
      score.className = `score${r ? '' : ' none'}`;
      score.textContent = r ? r : 'нет оценки';
      $$('[data-rate]', card).forEach((b) => {
        const on = Number(b.dataset.rate) <= (r || 0);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(Number(b.dataset.rate) === r));
      });
      const ta = $('[data-review]', card);
      if (ta && !dirty[p] && document.activeElement !== ta) ta.value = m.reviews?.[p] || '';
      const roEl = $('[data-review-ro]', card);
      if (roEl) roEl.textContent = m.reviews?.[p] || '';
    }
  };
  state.sheet.update = update;
  update();

  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.matches('[data-done]')) closeSheet();
    else if (t.matches('[data-edit]')) { flushReviews(); openMovieForm(state.movies.get(id)); }
    else if (t.matches('[data-markwatched]')) { haptic(); patchMovie(id, { watched: true, watchedAt: new Date().toISOString() }); }
    else if (t.matches('[data-unwatch]')) patchMovie(id, { watched: false, watchedAt: null });
    else if (t.matches('[data-vote]')) { haptic(); toggleVote(id, t.dataset.vote === 'yes'); }
    else if (t.matches('[data-rate]')) {
      haptic();
      const p = t.closest('[data-person]').dataset.person;
      const val = clampRating(t.dataset.rate);
      const cur = state.movies.get(id)?.ratings?.[p];
      patchMovie(id, { ratings: { [p]: cur === val ? null : val } });
    }
  });
  $$('[data-review]', sheet).forEach((ta) => {
    const p = ta.closest('[data-person]').dataset.person;
    ta.addEventListener('input', () => {
      dirty[p] = true;
      const st = $(`[data-person="${p}"] [data-save-state]`, sheet);
      st.className = 'save-state'; st.textContent = '';
      clearTimeout(timers[p]);
      timers[p] = setTimeout(() => saveReview(p), 1000);
    });
    ta.addEventListener('blur', () => { if (dirty[p]) saveReview(p); });
  });
}

/* ---------------- events ---------------- */
$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (!card || card.disabled) return;
  openDetail(Number(card.dataset.id));
});
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  store.set('cg_tab', state.tab);
  haptic();
  render();
});
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = b.dataset.filter;
  render();
});
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  store.set('cg_sort', state.sort);
  render();
});
$('#search').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});
$('#addBtn').addEventListener('click', () => openMovieForm());
$('#rouletteBtn').addEventListener('click', () => openRoulette());
$('#swipeBtn').addEventListener('click', () => openSwipe());
$('#meBtn').addEventListener('click', () => openMeSheet());
const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 36);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ---------------- boot ---------------- */
render();
setSync(state.loaded ? 'ok' : 'loading');
refresh({ force: true }).then(schedulePoll);
if (!state.me) setTimeout(() => { if (!state.sheet) openMeSheet(); }, 400);

window.__cinemagoal = { state, refresh };

import { test, expect } from '@playwright/test';
import { makeServer, openApp, SHUTTER } from './helpers.js';

const card = (page, title) => page.locator('#grid .card', { has: page.locator('.card-title', { hasText: title }) });
const details = (genres, runtime, extra = {}) => ({ genres, runtime, directors: [], description: '', wiki: 'x', ...extra });

test('adding a movie pulls genres, runtime, director and description from Wikipedia', async ({ browser }) => {
  const gh = makeServer();
  const { page } = await openApp(browser, gh);
  await page.locator('#addBtn').click();
  await page.locator('input[name="title"]').fill('Остров проклятых');
  await expect(page.locator('.pick[aria-pressed="true"] .pick-title')).toHaveText('Остров проклятых');
  await page.locator('[data-save]').click();

  await expect.poll(() => gh.movie(1).details?.runtime).toBe(138);
  expect(gh.movie(1).details).toMatchObject({
    wiki: 'Остров проклятых (фильм)', wikidata: 'Q210364', genres: SHUTTER.genres, directors: SHUTTER.directors, description: SHUTTER.description,
  });
  await expect(card(page, 'Остров проклятых').locator('.card-meta')).toHaveText('2010 · 2 ч 18 мин');

  await card(page, 'Остров проклятых').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.genre-chip')).toHaveText(['Триллер', 'Драма']);
  await expect(sheet.locator('.facts')).toContainText('⏱ 2 ч 18 мин');
  await expect(sheet.locator('.facts')).toContainText('🎬 Мартин Скорсезе');
  await expect(sheet.locator('.detail-desc p')).toHaveText(SHUTTER.description);
  const trailer = sheet.locator('[data-trailer]');
  await expect(trailer).toHaveAttribute('target', '_blank');
  expect(decodeURIComponent(await trailer.getAttribute('href'))).toBe('https://www.youtube.com/results?search_query=Остров проклятых 2010 трейлер');
  await expect(sheet.getByRole('link', { name: 'Википедия' })).toHaveAttribute('href', /ru\.wikipedia\.org\/wiki\//);
});

test('existing movies get details in the background; no match is remembered, not retried', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Остров проклятых', year: '2010' });
  gh.addMovie({ title: 'Фильм, которого нет в Википедии' });
  const { page } = await openApp(browser, gh);
  await expect.poll(() => gh.movie(1).details?.runtime, { timeout: 15000 }).toBe(138);
  await expect.poll(() => gh.movie(2).details?.missing, { timeout: 15000 }).toBe(true);
  await expect(card(page, 'Остров проклятых').locator('.card-meta')).toHaveText('2010 · 2 ч 18 мин');

  // a fresh visit does not look the movies up again
  const before = gh.wikiCalls.length;
  const second = await openApp(browser, gh);
  await expect(card(second.page, 'Остров проклятых')).toBeVisible();
  await second.page.waitForTimeout(2500);
  expect(gh.wikiCalls.length).toBe(before);

  // …but the edit sheet can refresh them on demand
  await card(second.page, 'Остров проклятых').click();
  await second.page.locator('[data-edit]').click();
  await second.page.locator('[data-refetch]').click();
  await expect(second.page.locator('#toast')).toContainText('Описание и жанры обновлены');
});

test('genre and length filters (also used by the roulette)', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Мы — Миллеры', details: details(['комедийный фильм', 'криминальный фильм'], 110) });
  gh.addMovie({ title: 'Суперчел', details: details(['комедийный фильм'], 82) });
  gh.addMovie({ title: 'Остров проклятых', details: details(['фильм-триллер', 'драматический фильм'], 138) });
  gh.addMovie({ title: 'Без данных', details: { missing: true } });
  const { page } = await openApp(browser, gh);
  await expect(page.locator('#grid .card')).toHaveCount(4);

  await expect(page.locator('#genre option')).toHaveText(['Все жанры', 'Комедия · 2', 'Драма · 1', 'Криминал · 1', 'Триллер · 1']);
  await page.locator('#genre').selectOption('Комедия');
  await expect(page.locator('#grid .card-title')).toHaveText(['Суперчел', 'Мы — Миллеры']);
  await page.locator('#length').selectOption('short');
  await expect(page.locator('#grid .card-title')).toHaveText(['Суперчел']);
  await expect(card(page, 'Суперчел').locator('.card-meta')).toHaveText('1 ч 22 мин');

  // roulette honours the same filters
  await page.locator('#rouletteBtn').click();
  await expect(page.locator('[data-note]')).toContainText('Выбираем из 1 фильма · фильтр: Комедия, до 1,5 ч');
  await page.locator('[data-spin]').click();
  await expect(page.locator('.win-title')).toHaveText('Суперчел');
  await page.locator('[data-close]').click();

  await page.locator('#genre').selectOption('Драма');
  await expect(page.locator('#grid .card')).toHaveCount(0);
  await expect(page.locator('#empty')).toContainText('Ничего не нашлось');
  await page.locator('#length').selectOption('long');
  await expect(page.locator('#grid .card-title')).toHaveText(['Остров проклятых']);

  // filters are remembered
  await page.reload();
  await expect(page.locator('#genre')).toHaveValue('Драма');
  await expect(page.locator('#length')).toHaveValue('long');
  await page.locator('#genre').selectOption('');
  await page.locator('#length').selectOption('any');
  await expect(page.locator('#grid .card')).toHaveCount(4);
});

test('activity feed: the other person’s actions show up with an unread badge', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Сплит', addedBy: 'maksim', addedAt: new Date(Date.now() - 86400000 * 3).toISOString() });
  const maksim = await openApp(browser, gh, { me: 'maksim' });
  const alina = await openApp(browser, gh, { me: 'alina' });
  await expect(maksim.page.locator('#grid .card')).toHaveCount(1);
  await expect(maksim.page.locator('#feedCount')).toBeHidden();

  // Алина adds a movie and votes on Максим's one
  await alina.page.locator('#addBtn').click();
  await alina.page.locator('input[name="title"]').fill('Терминал');
  await alina.page.locator('[data-who="alina"]').click();
  await alina.page.locator('[data-save]').click();
  await expect(alina.page.locator('#grid .card', { hasText: 'Терминал' })).toBeEnabled();
  await alina.page.locator('#grid .card', { hasText: 'Сплит' }).click();
  await alina.page.getByRole('button', { name: '👍 Хочу' }).click();
  await alina.page.locator('[data-done]').click();

  await expect(maksim.page.locator('#feedCount')).toHaveText('2');
  await maksim.page.locator('#feedBtn').click();
  const feed = maksim.page.getByRole('dialog', { name: 'Лента' });
  await expect(feed.locator('.feed-text')).toHaveText(['Алина хочет посмотреть «Сплит»', 'Алина добавила «Терминал»', 'Максим добавил «Сплит»']);
  await expect(feed.locator('.feed-row.fresh')).toHaveCount(2);
  await expect(feed.locator('.feed-day').first()).toHaveText('Сегодня');
  await expect(maksim.page.locator('#feedCount')).toBeHidden();

  // tapping an event opens the movie
  await feed.locator('.feed-row', { hasText: 'Терминал' }).click();
  await expect(maksim.page.getByRole('dialog').locator('.detail-title')).toHaveText('Терминал');

  // own actions don't light up your own badge
  await maksim.page.getByRole('button', { name: '👍 Хочу' }).click();
  await maksim.page.locator('[data-done]').click();
  await expect(maksim.page.locator('#feedCount')).toBeHidden();
  await expect(alina.page.locator('#feedCount')).toHaveText('1');
  await maksim.context.close();
  await alina.context.close();
});

test('feed records watching, rating and reviews; ratings within minutes collapse into one event', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Легенда', addedBy: 'alina' });
  const { page } = await openApp(browser, gh, { me: 'maksim' });
  await card(page, 'Легенда').click();
  await page.getByRole('button', { name: 'Посмотрели!' }).click();
  const mine = page.locator('[data-person="maksim"]');
  await mine.getByRole('radio', { name: '6', exact: true }).click();
  await mine.getByRole('radio', { name: '8', exact: true }).click();
  await mine.locator('textarea').fill('Харди хорош');
  await expect(mine.locator('[data-save-state]')).toHaveText('Сохранено');
  await expect.poll(() => Object.values(gh.movie(1).log).map((e) => e.type).sort()).toEqual(['rate', 'review', 'watch']);
  expect(Object.values(gh.movie(1).log).find((e) => e.type === 'rate').value).toBe(8);
  await page.locator('[data-done]').click();
  await page.locator('#feedBtn').click();
  await expect(page.locator('.feed-text')).toHaveText([
    'Максим написал отзыв о «Легенда»', 'Максим поставил 8/10 фильму «Легенда»', 'Максим отметил «Легенда» просмотренным', 'Алина добавила «Легенда»',
  ]);
});

test('reactions on the other person’s review sync to both phones', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({
    title: 'Мы — Миллеры', watched: true, watchedAt: new Date().toISOString(), details: { missing: true },
    ratings: { maksim: 9, alina: 7 }, reviews: { maksim: 'Ржал весь фильм', alina: 'Мило' },
  });
  const maksim = await openApp(browser, gh, { me: 'maksim' });
  const alina = await openApp(browser, gh, { me: 'alina' });
  await maksim.page.getByRole('tab', { name: /Посмотрели/ }).click();
  await alina.page.getByRole('tab', { name: /Посмотрели/ }).click();
  await card(maksim.page, 'Мы — Миллеры').click();
  await card(alina.page, 'Мы — Миллеры').click();

  // you can react to the other person's review, not your own
  await expect(maksim.page.locator('[data-person="maksim"] .react-bar')).toHaveCount(0);
  await maksim.page.locator('[data-person="alina"] [data-react="❤️"]').click();
  await alina.page.locator('[data-person="maksim"] [data-react="😂"]').click();
  await alina.page.locator('[data-person="maksim"] [data-react="🔥"]').click();
  await alina.page.locator('[data-person="maksim"] [data-react="🔥"]').click(); // toggled off again

  await expect.poll(() => gh.movie(1).reactions).toEqual({
    maksim: { alina: { '😂': true, '🔥': false } }, alina: { maksim: { '❤️': true } },
  });
  await expect(maksim.page.locator('[data-person="maksim"] .got-chip')).toHaveText(['😂А']);
  await expect(alina.page.locator('[data-person="alina"] .got-chip')).toHaveText(['❤️М']);
  await expect(alina.page.locator('[data-person="maksim"] [data-react="😂"]')).toHaveAttribute('aria-pressed', 'true');

  await maksim.page.locator('[data-done]').click();
  await maksim.page.locator('#feedBtn').click();
  await expect(maksim.page.locator('.feed-text').first()).toHaveText('Алина отреагировала 😂 на отзыв Максима о «Мы — Миллеры»');
  await maksim.context.close();
  await alina.context.close();
});

test('view-only visitors see details and reactions but cannot react', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({
    title: 'Стекло', watched: true, details: details(['фильм-триллер'], 129, { directors: ['М. Найт Шьямалан'] }),
    reviews: { maksim: 'Ну такое', alina: '' }, reactions: { maksim: { alina: { '😢': true } } },
  });
  const { page } = await openApp(browser, gh, { token: null });
  await page.getByRole('tab', { name: /Посмотрели/ }).click();
  await card(page, 'Стекло').click();
  await expect(page.locator('.genre-chip')).toHaveText(['Триллер']);
  await expect(page.locator('.facts')).toContainText('2 ч 9 мин');
  await expect(page.locator('[data-person="maksim"] .got-chip')).toHaveText(['😢А']);
  await expect(page.locator('.react-btn')).toHaveCount(0);
  await expect(page.locator('[data-trailer]')).toBeVisible();
});

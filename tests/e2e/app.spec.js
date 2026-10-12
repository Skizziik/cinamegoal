import { test, expect } from '@playwright/test';
import { makeServer, openApp } from './helpers.js';

const card = (page, title) => page.locator('.card', { has: page.locator('.card-title', { hasText: title }) });

function seedBasics(gh) {
  gh.addMovie({ title: 'Бойцовский клуб', year: '1999', addedBy: 'maksim' });
  gh.addMovie({ title: 'Мы — Миллеры', year: '2013', addedBy: 'alina', note: 'Совет Кати' });
  gh.addMovie({
    title: 'Остров проклятых', year: '2010', addedBy: 'maksim', watched: true,
    watchedAt: '2026-10-05T20:00:00Z', ratings: { maksim: 9, alina: 8 }, reviews: { maksim: 'Концовка!', alina: '' },
  });
}

test('list fits the phone screen and tabs split to-watch / watched', async ({ browser }) => {
  const gh = makeServer();
  seedBasics(gh);
  const { page } = await openApp(browser, gh);

  await expect(page.locator('.card')).toHaveCount(2);
  await expect(card(page, 'Бойцовский клуб')).toBeVisible();
  await expect(page.locator('#stats')).toHaveText('3 фильма · 1 посмотрели · средняя 8.5');
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'ok');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const fab = await page.locator('#addBtn').boundingBox();
  const vp = page.viewportSize();
  expect(fab.y + fab.height).toBeLessThanOrEqual(vp.height);
  expect(fab.x).toBeGreaterThanOrEqual(0);

  await page.getByRole('tab', { name: /Посмотрели/ }).click();
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(card(page, 'Остров проклятых').locator('.badge.score')).toHaveText('8.5');

  await page.getByRole('tab', { name: /Хотим/ }).click();
  await page.locator('#filters [data-filter="alina"]').click();
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(card(page, 'Мы — Миллеры')).toBeVisible();
  await page.locator('#filters [data-filter="all"]').click();
  await page.locator('#search').fill('бойц');
  await expect(page.locator('.card')).toHaveCount(1);
  await expect(card(page, 'Бойцовский клуб')).toBeVisible();
});

test('first visit asks who you are and remembers it', async ({ browser }) => {
  const gh = makeServer();
  const { page } = await openApp(browser, gh, { me: null });
  const sheet = page.getByRole('dialog', { name: 'Кто ты?' });
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-me="alina"]').click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('#meBtn')).toContainText('Алина');
  await page.reload();
  await expect(page.locator('#meBtn')).toContainText('Алина');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('add a movie with an auto-found poster', async ({ browser }) => {
  const gh = makeServer();
  const { page } = await openApp(browser, gh);
  await expect(page.locator('.empty')).toContainText('Список пуст');

  await page.locator('#addBtn').click();
  const sheet = page.getByRole('dialog', { name: 'Новый фильм' });
  await expect(sheet).toBeVisible();
  const save = sheet.locator('[data-save]');
  await expect(save).toBeDisabled();
  await sheet.locator('input[name="title"]').fill('Остров проклятых');
  await expect(sheet.locator('.pick[aria-pressed="true"] .pick-title')).toHaveText('Остров проклятых');
  await expect(sheet.locator('input[name="year"]')).toHaveValue('2010');
  await sheet.locator('[data-who="alina"]').click();
  await sheet.locator('textarea[name="note"]').fill('Хочу пересмотреть');
  await save.click();

  await expect(card(page, 'Остров проклятых')).toBeVisible();
  await expect.poll(() => gh.issues.length).toBe(1);
  const saved = gh.movie(1);
  expect(saved).toMatchObject({ title: 'Остров проклятых', year: '2010', addedBy: 'alina', note: 'Хочу пересмотреть', watched: false, poster: '/icons/icon-512.png', original: 'Shutter Island' });
  await expect(card(page, 'Остров проклятых').locator('.badge.who')).toHaveText('А');

  // duplicate warning
  await page.locator('#addBtn').click();
  await page.locator('input[name="title"]').fill('остров  проклятых');
  await expect(page.locator('[data-dup]')).toBeVisible();
});

test('mark watched, rate 1-10 and write impressions', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Лицо со шрамом', year: '1983', addedBy: 'maksim' });
  const { page } = await openApp(browser, gh);

  await card(page, 'Лицо со шрамом').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('.detail-title')).toHaveText('Лицо со шрамом');
  await expect(sheet.locator('[data-ratings]')).toBeHidden();
  await sheet.getByRole('button', { name: 'Посмотрели!' }).click();
  await expect(sheet.locator('[data-ratings]')).toBeVisible();

  const mine = sheet.locator('[data-person="maksim"]');
  await mine.getByRole('radio', { name: '8', exact: true }).click();
  await expect(mine.locator('[data-score]')).toHaveText('8');
  await mine.locator('textarea').fill('Say hello to my little friend');
  await expect(mine.locator('[data-save-state]')).toHaveText('Сохранено');

  await expect.poll(() => gh.movie(1)).toMatchObject({
    watched: true, ratings: { maksim: 8, alina: null }, reviews: { maksim: 'Say hello to my little friend' },
  });
  expect(gh.movie(1).watchedAt).toBeTruthy();

  // tap the same score again to clear it
  await mine.getByRole('radio', { name: '8', exact: true }).click();
  await expect(mine.locator('[data-score]')).toHaveText('нет оценки');
  await expect.poll(() => gh.movie(1).ratings.maksim).toBe(null);
  await mine.getByRole('radio', { name: '10', exact: true }).click();
  await expect.poll(() => gh.movie(1).ratings.maksim).toBe(10);

  await sheet.locator('[data-done]').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: /Посмотрели/ }).click();
  await expect(card(page, 'Лицо со шрамом').locator('.badge.score')).toHaveText('10');
  await expect(card(page, 'Лицо со шрамом').locator('.card-meta')).toHaveText('М 10');
});

test('Максим and Алина see each other\'s changes live', async ({ browser }) => {
  const gh = makeServer();
  const maksim = await openApp(browser, gh, { me: 'maksim' });
  const alina = await openApp(browser, gh, { me: 'alina' });

  // Максим adds a movie → it appears for Алина without reloading
  await maksim.page.locator('#addBtn').click();
  await maksim.page.locator('input[name="title"]').fill('Поймай меня, если сможешь');
  await maksim.page.locator('[data-save]').click();
  await expect(card(alina.page, 'Поймай меня, если сможешь')).toBeVisible();
  await expect(card(alina.page, 'Поймай меня, если сможешь').locator('.badge.who')).toHaveText('М');

  // Алина watches + rates → Максим sees it move to "Посмотрели" with her score
  await card(alina.page, 'Поймай меня, если сможешь').click();
  await alina.page.getByRole('button', { name: 'Посмотрели!' }).click();
  await alina.page.locator('[data-person="alina"]').getByRole('radio', { name: '9', exact: true }).click();
  await alina.page.locator('[data-person="alina"] textarea').fill('Ди Каприо 🔥');
  await expect(alina.page.locator('[data-person="alina"] [data-save-state]')).toHaveText('Сохранено');

  await expect(card(maksim.page, 'Поймай меня, если сможешь')).toHaveCount(0);
  await maksim.page.getByRole('tab', { name: /Посмотрели/ }).click();
  await expect(card(maksim.page, 'Поймай меня, если сможешь').locator('.badge.score')).toHaveText('9');

  // Максим opens the same movie and sees Алина's review
  await card(maksim.page, 'Поймай меня, если сможешь').click();
  await expect(maksim.page.locator('[data-person="alina"] textarea')).toHaveValue('Ди Каприо 🔥');
  await expect(maksim.page.locator('[data-person="alina"] [data-score]')).toHaveText('9');

  // the open detail sheet updates live too
  await alina.page.locator('[data-person="alina"]').getByRole('radio', { name: '7', exact: true }).click();
  await expect(maksim.page.locator('[data-person="alina"] [data-score]')).toHaveText('7');

  await maksim.context.close();
  await alina.context.close();
});

test('simultaneous edits by both people are merged, not overwritten', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Легенда', addedBy: 'alina', watched: true, watchedAt: '2026-10-01T20:00:00Z' });
  const maksim = await openApp(browser, gh, { me: 'maksim' });
  const alina = await openApp(browser, gh, { me: 'alina' });
  await maksim.page.getByRole('tab', { name: /Посмотрели/ }).click();
  await alina.page.getByRole('tab', { name: /Посмотрели/ }).click();
  await card(maksim.page, 'Легенда').click();
  await card(alina.page, 'Легенда').click();

  await Promise.all([
    maksim.page.locator('[data-person="maksim"]').getByRole('radio', { name: '6', exact: true }).click(),
    alina.page.locator('[data-person="alina"]').getByRole('radio', { name: '10', exact: true }).click(),
  ]);
  await Promise.all([
    maksim.page.locator('[data-person="maksim"] textarea').fill('Том Харди x2'),
    alina.page.locator('[data-person="alina"] textarea').fill('Обожаю'),
  ]);

  await expect.poll(() => gh.movie(1)).toMatchObject({
    ratings: { maksim: 6, alina: 10 }, reviews: { maksim: 'Том Харди x2', alina: 'Обожаю' },
  });
  for (const { page } of [maksim, alina]) {
    await expect(page.locator('[data-avg] b')).toHaveText('8');
    await expect(page.locator('[data-person="maksim"] [data-score]')).toHaveText('6');
    await expect(page.locator('[data-person="alina"] [data-score]')).toHaveText('10');
  }
  await maksim.context.close();
  await alina.context.close();
});

test('edit, delete and undo', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Суперчел', addedBy: 'maksim' });
  const { page } = await openApp(browser, gh);

  await card(page, 'Суперчел').click();
  await page.locator('[data-edit]').click();
  const form = page.getByRole('dialog', { name: 'Изменить' });
  await form.locator('input[name="title"]').fill('Суперчел (2021)');
  await form.locator('input[name="year"]').fill('2021');
  await form.locator('[data-save]').click();
  await expect(card(page, 'Суперчел (2021)')).toBeVisible();
  await expect.poll(() => gh.movie(1)).toMatchObject({ title: 'Суперчел (2021)', year: '2021', issueTitle: 'Суперчел (2021)' });

  page.once('dialog', (d) => d.accept());
  await card(page, 'Суперчел').click();
  await page.locator('[data-edit]').click();
  await page.locator('[data-delete]').click();
  await expect(page.locator('.card')).toHaveCount(0);
  await expect.poll(() => gh.movie(1).state).toBe('closed');

  await page.locator('#toast button', { hasText: 'Вернуть' }).click();
  await expect(card(page, 'Суперчел (2021)')).toBeVisible();
  await expect.poll(() => gh.movie(1).state).toBe('open');
});

test('without a key the site is view-only; pasting the key unlocks editing', async ({ browser }) => {
  const gh = makeServer();
  seedBasics(gh);
  const { page } = await openApp(browser, gh, { token: null });
  await expect(page.locator('.card')).toHaveCount(2);
  await expect(page.locator('#banner')).toContainText('Режим просмотра');
  await expect(page.locator('#addBtn')).toBeHidden();
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'readonly');
  await card(page, 'Бойцовский клуб').click();
  await expect(page.getByRole('button', { name: 'Посмотрели!' })).toHaveCount(0);
  await page.locator('[data-done]').click();

  await page.locator('#keyInput').fill('wrong-key');
  await page.locator('#keyForm button').click();
  await expect(page.locator('#banner')).toContainText('Ключ доступа не подошёл');

  await page.locator('#keyInput').fill(gh.token);
  await page.locator('#keyForm button').click();
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('#addBtn')).toBeVisible();
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'ok');
});

test('invite link stores the key and cleans the URL', async ({ browser }) => {
  const gh = makeServer();
  const { page } = await openApp(browser, gh, { token: null, url: `/#key=${gh.token}` });
  await expect(page.locator('#addBtn')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(() => localStorage.getItem('cg_token'))).toBe(gh.token);
});

test('form inputs are at least 16px so iOS does not zoom', async ({ browser }) => {
  const gh = makeServer();
  const { page } = await openApp(browser, gh);
  await page.locator('#addBtn').click();
  const sizes = await page.locator('input, textarea').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
});

import { test, expect } from '@playwright/test';
import { makeServer, openApp } from './helpers.js';

const card = (page, title) => page.locator('#grid .card', { has: page.locator('.card-title', { hasText: title }) });

// Drags the top swipe card horizontally with pointer events (works in WebKit, Chromium, touch and mouse).
async function dragTopCard(page, dx) {
  const top = page.locator('.swipe-card.top');
  const box = await top.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await top.dispatchEvent('pointerdown', { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  for (let i = 1; i <= 6; i++) {
    await page.evaluate(([cx, cy]) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: cx, clientY: cy, pointerId: 1 })), [x + (dx * i) / 6, y]);
  }
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 })));
}

test('vote in the movie card: both want it → 💞 badge and it moves to the top', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Сплит', addedBy: 'alina', addedAt: '2026-01-01T00:00:00Z', votes: { alina: true } });
  gh.addMovie({ title: 'Легенда', addedBy: 'alina', addedAt: '2026-05-01T00:00:00Z' });
  gh.addMovie({ title: 'Суперчел', addedBy: 'maksim', addedAt: '2026-09-01T00:00:00Z' });
  const { page } = await openApp(browser, gh);

  await expect(page.locator('#grid .card-title').first()).toHaveText('Сплит', { timeout: 8000 }); // Алина already wants it
  await card(page, 'Сплит').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('[data-vote-of="alina"]')).toContainText('Алина хочет 👍');
  await sheet.getByRole('button', { name: '👍 Хочу' }).click();
  await expect(sheet.locator('.match-banner')).toContainText('Совпадение');
  await expect(page.locator('#toast')).toContainText('Оба хотите «Сплит»');
  await expect.poll(() => gh.movie(1).votes).toEqual({ maksim: true, alina: true });
  await sheet.locator('[data-done]').click();
  await expect(card(page, 'Сплит').locator('.badge.match')).toBeVisible();

  // "не хочу" sinks a movie to the bottom; tapping again clears the vote
  await card(page, 'Суперчел').click();
  await page.getByRole('button', { name: '👎 Не хочу' }).click();
  await expect(page.getByRole('button', { name: '👎 Не хочу' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => gh.movie(3).votes.maksim).toBe(false);
  await page.locator('[data-done]').click();
  await expect(page.locator('#grid .card-title')).toHaveText(['Сплит', 'Легенда', 'Суперчел']);
  await card(page, 'Суперчел').click();
  await page.getByRole('button', { name: '👎 Не хочу' }).click();
  await expect.poll(() => gh.movie(3).votes.maksim).toBe(null);
});

test('swipes: right = want, left = not, match screen, undo, keyboard', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Уже голосовал', addedAt: '2026-10-05T00:00:00Z', votes: { maksim: true } });
  gh.addMovie({ title: 'Терминал', addedBy: 'alina', addedAt: '2026-10-04T00:00:00Z', votes: { alina: true } });
  gh.addMovie({ title: 'Один дома', addedBy: 'alina', addedAt: '2026-10-03T00:00:00Z' });
  gh.addMovie({ title: 'Интерстеллар', addedBy: 'maksim', addedAt: '2026-10-02T00:00:00Z' });
  const { page } = await openApp(browser, gh);

  await expect(page.locator('#swipeCount')).toHaveText('3');
  await page.locator('#swipeBtn').click();
  const sheet = page.getByRole('dialog', { name: 'Свайпы' });
  await expect(sheet.locator('[data-progress]')).toHaveText('1 из 3');
  const top = sheet.locator('.swipe-card.top');
  await expect(top.locator('.swipe-title')).toHaveText('Терминал');
  await expect(top.locator('.swipe-tag')).toHaveText('Алина хочет 👍');

  // swipe right → match with Алина
  await dragTopCard(page, 220);
  await expect(sheet.locator('.match-overlay')).toBeVisible();
  await expect(sheet.locator('.match-sub')).toContainText('«Терминал»');
  await sheet.getByRole('button', { name: 'Продолжить' }).click();
  await expect(sheet.locator('.match-overlay')).toBeHidden();

  // small drag snaps back without voting
  await expect(top.locator('.swipe-title')).toHaveText('Один дома');
  await dragTopCard(page, 30);
  await expect(top.locator('.swipe-title')).toHaveText('Один дома');

  // swipe left → не хочу
  await dragTopCard(page, -220);
  await expect(top.locator('.swipe-title')).toHaveText('Интерстеллар');
  await expect.poll(() => gh.movie(3).votes.maksim).toBe(false);

  // undo restores the previous card and clears the vote
  await sheet.locator('[data-undo]').click();
  await expect(top.locator('.swipe-title')).toHaveText('Один дома');
  await expect.poll(() => gh.movie(3).votes.maksim).toBe(null);
  await sheet.getByRole('button', { name: 'Хочу', exact: true }).click();
  await expect(top.locator('.swipe-title')).toHaveText('Интерстеллар');
  await page.keyboard.press('ArrowLeft');

  await expect(sheet.locator('.swipe-done')).toContainText('проголосовал(а) за все фильмы');
  await expect(sheet.locator('.swipe-done')).toContainText('Новых совпадений: 1');
  await expect.poll(() => [2, 3, 4].map((n) => gh.movie(n).votes.maksim)).toEqual([true, true, false]);
  expect(gh.movie(1).votes.maksim).toBe(true);

  await sheet.locator('[data-close]').click();
  await expect(page.locator('#swipeCount')).toBeHidden();
  await expect(page.locator('#swipeHint')).toHaveText('Всё проголосовано ✓');
  await expect(card(page, 'Терминал').locator('.badge.match')).toBeVisible();
});

test('roulette only picks allowed movies and opens the winner', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Оба хотят', addedBy: 'maksim', votes: { maksim: true, alina: true } });
  gh.addMovie({ title: 'Нейтральный', addedBy: 'maksim' });
  gh.addMovie({ title: 'Отклонён', addedBy: 'maksim', votes: { alina: false } });
  gh.addMovie({ title: 'Уже видели', addedBy: 'maksim', watched: true });
  const { page } = await openApp(browser, gh);

  await page.locator('#rouletteBtn').click();
  const sheet = page.getByRole('dialog', { name: 'Что смотрим?' });
  await expect(sheet.locator('[data-note]')).toHaveText('Выбираем из 2 фильмов · без тех, что кто-то отклонил');

  const winners = new Set();
  for (let i = 0; i < 4; i++) {
    await sheet.locator('[data-spin]').click();
    await expect(sheet.locator('.win-title')).toBeVisible();
    const w = await sheet.locator('.win-title').textContent();
    winners.add(w);
    expect(['Оба хотят', 'Нейтральный']).toContain(w);
    await expect(sheet.locator('.reel-item.win')).toHaveCount(1);
    await expect(sheet.locator('[data-spin]')).toHaveText('🎲 Ещё раз');
  }

  await sheet.locator('[data-mode="match"]').click();
  await expect(sheet.locator('[data-note]')).toHaveText('Выбираем из 1 фильма');
  await sheet.locator('[data-spin]').click();
  await expect(sheet.locator('.win-title')).toHaveText('Оба хотят');
  await expect(sheet.locator('.win-meta')).toContainText('💞');

  await sheet.locator('[data-mode="alina"]').click();
  await expect(sheet.locator('[data-spin]')).toBeDisabled();
  await expect(sheet.locator('[data-note]')).toHaveText('Тут пока пусто');

  await sheet.locator('[data-mode="match"]').click();
  await sheet.locator('[data-spin]').click();
  await sheet.getByRole('button', { name: '🍿 Смотрим!' }).click();
  await expect(page.getByRole('dialog').locator('.detail-title')).toHaveText('Оба хотят');
  expect(await page.evaluate(() => localStorage.getItem('cg_roulette'))).toBe('match');
});

test('Максим and Алина swipe on their phones and both see the match', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Богемская рапсодия', addedBy: 'maksim' });
  const maksim = await openApp(browser, gh, { me: 'maksim' });
  const alina = await openApp(browser, gh, { me: 'alina' });

  await maksim.page.locator('#swipeBtn').click();
  await maksim.page.getByRole('button', { name: 'Хочу', exact: true }).click();
  await expect(maksim.page.locator('.swipe-done')).toContainText('Совпадения появятся');
  await maksim.page.locator('[data-close]').click();

  // Алина's phone picks up Максим's vote, then she swipes right → match
  await expect(alina.page.locator('#swipeCount')).toHaveText('1');
  await alina.page.waitForFunction(() => window.__cinemagoal.state.movies.get(1)?.votes.maksim === true);
  await alina.page.locator('#swipeBtn').click();
  await expect(alina.page.locator('.swipe-card.top .swipe-tag')).toHaveText('Максим хочет 👍', { timeout: 8000 });
  await alina.page.getByRole('button', { name: 'Хочу', exact: true }).click();
  await expect(alina.page.locator('.match-title')).toHaveText('Это мэтч! 💞');

  // Максим sees it live
  await expect(card(maksim.page, 'Богемская рапсодия').locator('.badge.match')).toBeVisible();
  await card(maksim.page, 'Богемская рапсодия').click();
  await expect(maksim.page.locator('.match-banner')).toBeVisible();
  await expect(maksim.page.locator('[data-vote-of="alina"]')).toContainText('хочет 👍');
  await maksim.context.close();
  await alina.context.close();
});

test('view-only visitors can spin the roulette but not vote or swipe', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Мы — Миллеры', addedBy: 'alina', votes: { alina: true } });
  const { page } = await openApp(browser, gh, { token: null });
  await expect(page.locator('#swipeBtn')).toBeHidden();
  await card(page, 'Мы — Миллеры').click();
  await expect(page.getByRole('button', { name: '👍 Хочу' })).toHaveCount(0);
  await expect(page.locator('[data-vote-of="alina"]')).toContainText('Алина хочет 👍');
  await expect(page.locator('[data-vote-of="maksim"]')).toContainText('ещё не решил');
  await page.locator('[data-done]').click();
  await page.locator('#rouletteBtn').click();
  await page.locator('[data-spin]').click();
  await expect(page.locator('.win-title')).toHaveText('Мы — Миллеры');
});

test('quick actions are hidden on the watched tab', async ({ browser }) => {
  const gh = makeServer();
  gh.addMovie({ title: 'Легенда' });
  const { page } = await openApp(browser, gh);
  await expect(page.locator('#quick')).toBeVisible();
  await page.getByRole('tab', { name: /Посмотрели/ }).click();
  await expect(page.locator('#quick')).toBeHidden();
});

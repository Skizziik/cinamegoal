// Visual snapshots for manual review: SHOTS=1 npx playwright test shots
import { test } from '@playwright/test';
import { makeServer, openApp } from './helpers.js';

test.skip(!process.env.SHOTS, 'manual only');

test('screens', async ({ browser }, info) => {
  const gh = makeServer();
  const p = '/icons/icon-512.png';
  gh.addMovie({ title: 'Бойцовский клуб', year: '1999', addedBy: 'maksim' });
  gh.addMovie({ title: 'Мы — Миллеры', year: '2013', addedBy: 'alina', note: 'Совет Кати', poster: p, addedAt: '2026-10-11T00:00:00Z', votes: { alina: true } });
  gh.addMovie({ title: 'Неуязвимый — Сплит — Стекло — Стекло 2', addedBy: 'maksim' });
  gh.addMovie({ title: 'Апокалипсис по-голливудски', year: '2013', addedBy: 'alina' });
  gh.addMovie({ title: 'Остров проклятых', year: '2010', addedBy: 'maksim', poster: p, original: 'Shutter Island', watched: true, watchedAt: '2026-10-05T20:00:00Z', ratings: { maksim: 9, alina: 8 }, reviews: { maksim: 'Концовка взорвала мозг', alina: 'Жутковато, но очень круто' } });
  const { page } = await openApp(browser, gh, { me: 'maksim' });
  await page.waitForSelector('.card');
  await page.waitForTimeout(600);
  const dir = `shots/${info.project.name}`;
  await page.screenshot({ path: `${dir}-1-list.png` });
  await page.getByRole('tab', { name: /Посмотрели/ }).click();
  await page.waitForTimeout(400);
  await page.locator('.card').first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}-2-detail.png` });
  await page.locator('[data-done]').click();
  await page.waitForTimeout(400);
  await page.locator('#addBtn').click();
  await page.locator('input[name="title"]').fill('Остров проклятых');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${dir}-3-add.png` });
  await page.locator('[data-cancel]').click();
  await page.waitForTimeout(400);

  await page.getByRole('tab', { name: /Хотим/ }).click();
  await page.locator('.card').first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}-4-votes.png` });
  await page.locator('[data-done]').click();
  await page.waitForTimeout(400);

  await page.locator('#rouletteBtn').click();
  await page.locator('[data-spin]').click();
  await page.waitForSelector('.win-title');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}-5-roulette.png` });
  await page.locator('[data-close]').click();
  await page.waitForTimeout(400);

  await page.locator('#swipeBtn').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}-6-swipe.png` });
  await page.locator('[data-yes]').click();
  await page.waitForSelector('.match-title');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}-7-match.png` });
});

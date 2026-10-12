// End-to-end check against the deployed site and the real GitHub API.
// LIVE_TOKEN=<token> npx playwright test live --project=iphone --project=android
import { test, expect } from '@playwright/test';

const SITE = process.env.LIVE_URL || 'https://skizziik.github.io/cinamegoal/';
test.skip(!process.env.LIVE_TOKEN, 'needs LIVE_TOKEN');
test.setTimeout(120000);

async function open(browser, me) {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });
  await context.addInitScript(({ me, token }) => {
    localStorage.setItem('cg_me', me);
    localStorage.setItem('cg_token', token);
    localStorage.setItem('cg_poll', '3000');
  }, { me, token: process.env.LIVE_TOKEN });
  const page = await context.newPage();
  await page.goto(SITE);
  await expect(page.locator('#sync')).toHaveAttribute('data-state', 'ok', { timeout: 20000 });
  return { context, page };
}

test('two devices stay in sync through GitHub', async ({ browser }, info) => {
  const title = `Тест ${info.project.name} ${Date.now().toString(36)}`;
  const card = (page) => page.locator('.card', { has: page.locator('.card-title', { hasText: title }) });
  const a = await open(browser, 'maksim');
  const b = await open(browser, 'alina');
  await expect(a.page.locator('.card').first()).toBeVisible();

  await a.page.locator('#addBtn').click();
  await a.page.locator('input[name="title"]').fill(title);
  await a.page.locator('[data-who="maksim"]').click();
  await a.page.locator('[data-save]').click();
  await expect(card(a.page)).toBeVisible();
  await expect(card(a.page)).toBeEnabled({ timeout: 20000 }); // created on GitHub

  await expect(card(b.page)).toBeVisible({ timeout: 30000 });
  await card(b.page).click();
  await b.page.getByRole('button', { name: 'Посмотрели!' }).click();
  await b.page.locator('[data-person="alina"]').getByRole('radio', { name: '9', exact: true }).click();
  await b.page.locator('[data-person="alina"] textarea').fill('живой тест');
  await expect(b.page.locator('[data-person="alina"] [data-save-state]')).toHaveText('Сохранено', { timeout: 20000 });

  await a.page.getByRole('tab', { name: /Посмотрели/ }).click();
  await expect(card(a.page).locator('.badge.score')).toHaveText('9', { timeout: 30000 });
  await card(a.page).click();
  await expect(a.page.locator('[data-person="alina"] textarea')).toHaveValue('живой тест');
  await a.page.locator('[data-person="maksim"]').getByRole('radio', { name: '7', exact: true }).click();
  await expect(b.page.locator('[data-person="maksim"] [data-score]')).toHaveText('7', { timeout: 30000 });

  // clean up: delete from B, disappears on A
  b.page.once('dialog', (d) => d.accept());
  await b.page.locator('[data-edit]').click();
  await b.page.locator('[data-delete]').click();
  await a.page.locator('[data-done]').click();
  await expect(card(a.page)).toHaveCount(0, { timeout: 30000 });
  await a.context.close();
  await b.context.close();
});

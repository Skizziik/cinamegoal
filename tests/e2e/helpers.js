import { test } from '@playwright/test';
import { FakeGitHub } from '../fake-github.js';
import { serializeBody, emptyMovie } from '../../js/store.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match, Accept',
  'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
  'access-control-expose-headers': 'ETag, Link',
};

export function makeServer() {
  const gh = new FakeGitHub();
  gh.addMovie = (fields) => {
    const m = emptyMovie({ addedAt: gh.now(), ...fields });
    return gh.seed(m.title, serializeBody(m));
  };
  gh.movie = (n) => {
    const issue = gh.issues.find((i) => i.number === n);
    const raw = issue.body.slice(issue.body.lastIndexOf('<!-- cinemagoal:data') + 20, issue.body.lastIndexOf('-->'));
    return { ...JSON.parse(raw), state: issue.state, issueTitle: issue.title };
  };
  return gh;
}

const WIKI = {
  'остров': {
    ru: { query: { pages: { 1: { index: 1, title: 'Остров проклятых (фильм)', description: 'психологический триллер 2010 года', langlinks: [{ lang: 'en', '*': 'Shutter Island (film)' }] } } } },
    en: { query: { pages: { 2: { title: 'Shutter Island (film)', thumbnail: { source: '/icons/icon-512.png' } } } } },
  },
};

// Opens the app in a fresh browser context wired to the shared fake GitHub.
export async function openApp(browser, gh, { me = 'maksim', token = gh.token, url = '/' } = {}) {
  // Manually created contexts don't inherit the project's device settings, so pass them through.
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL } = test.info().project.use;
  const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, baseURL, locale: 'ru-RU' });
  const supports304 = browser.browserType().name() !== 'webkit';
  await context.addInitScript(({ me, token }) => {
    if (sessionStorage.getItem('cg_init')) return;
    sessionStorage.setItem('cg_init', '1');
    localStorage.setItem('cg_poll', '400');
    if (me) localStorage.setItem('cg_me', me);
    if (token) localStorage.setItem('cg_token', token);
  }, { me, token });
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const headers = await req.allHeaders();
    // Playwright's WebKit can't fulfill a 304, so serve full responses there.
    if (!supports304) delete headers['if-none-match'];
    const r = gh.handle({ method: req.method(), url: req.url(), headers, body: req.postData() });
    return route.fulfill({ status: r.status, headers: { ...CORS, ...r.headers }, body: r.body });
  });
  await context.route(/wikipedia\.org/, (route) => {
    const u = new URL(route.request().url());
    const q = (u.searchParams.get('gsrsearch') || u.searchParams.get('titles') || '').toLowerCase();
    const hit = Object.entries(WIKI).find(([k]) => q.includes(k) || q.includes('shutter'));
    const body = hit ? hit[1][u.host.startsWith('ru') ? 'ru' : 'en'] : { query: { pages: {} } };
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(url);
  return { context, page };
}

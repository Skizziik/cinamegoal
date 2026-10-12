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

// A tiny Wikipedia + Wikidata that knows one film, «Остров проклятых» (2010).
const SHUTTER_PAGE = 'Остров проклятых (фильм)';
export const SHUTTER = {
  description: '«Остров проклятых» — психологический триллер Мартина Скорсезе.',
  runtime: 138,
  genres: ['психологический фильм-триллер', 'драматический фильм'],
  directors: ['Мартин Скорсезе'],
};
const json = (body) => ({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });

function wikiResponse(url) {
  const u = new URL(url);
  const p = u.searchParams;
  const search = (p.get('gsrsearch') || '').toLowerCase();
  const titles = p.get('titles') || '';
  if (u.host === 'www.wikidata.org') {
    if (p.get('props') === 'claims') {
      return json({ entities: { Q210364: { claims: {
        P136: [{ mainsnak: { datavalue: { value: { id: 'Q1' } } } }, { mainsnak: { datavalue: { value: { id: 'Q2' } } } }],
        P57: [{ mainsnak: { datavalue: { value: { id: 'Q3' } } } }],
        P2047: [{ mainsnak: { datavalue: { value: { amount: `+${SHUTTER.runtime}`, unit: 'http://www.wikidata.org/entity/Q7727' } } } }],
      } } } });
    }
    return json({ entities: {
      Q1: { labels: { ru: { value: SHUTTER.genres[0] } } },
      Q2: { labels: { ru: { value: SHUTTER.genres[1] } } },
      Q3: { labels: { ru: { value: SHUTTER.directors[0] } } },
    } });
  }
  if (u.host.startsWith('en.')) {
    return json({ query: { pages: titles.includes('Shutter') ? { 2: { title: 'Shutter Island (film)', thumbnail: { source: '/icons/icon-512.png' } } } : {} } });
  }
  if (search) {
    return json({ query: { pages: search.includes('остров')
      ? { 1: { index: 1, title: SHUTTER_PAGE, description: 'психологический триллер 2010 года', langlinks: [{ lang: 'en', '*': 'Shutter Island (film)' }] } }
      : {} } });
  }
  if (titles === SHUTTER_PAGE) {
    return json({ query: { pages: { 1: { title: SHUTTER_PAGE, extract: SHUTTER.description, pageprops: { wikibase_item: 'Q210364' } } } } });
  }
  return json({ query: { pages: { '-1': { title: titles, missing: '' } } } });
}

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
    localStorage.setItem('cg_spin_ms', '500');
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
  gh.wikiCalls ??= [];
  await context.route(/(wikipedia|wikidata)\.org/, (route) => {
    gh.wikiCalls.push(route.request().url());
    return route.fulfill(wikiResponse(route.request().url()));
  });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (e) => { throw e; });
  await page.goto(url);
  return { context, page };
}

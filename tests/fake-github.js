// In-memory stand-in for the subset of the GitHub Issues REST API the app uses.
// Shared by unit tests (as a fetch implementation) and Playwright (via page.route),
// so several browser contexts can talk to the same "server" and see each other's edits.
import { createHash } from 'node:crypto';

export class FakeGitHub {
  constructor({ owner = 'Skizziik', repo = 'cinamegoal', token = 'test-token', readOnlyToken = 'read-only-token' } = {}) {
    this.readOnlyToken = readOnlyToken;
    this.prefix = `/repos/${owner}/${repo}`;
    this.token = token;
    this.issues = [];
    this.nextNumber = 1;
    this.requests = [];
    this.clock = Date.parse('2026-10-01T10:00:00Z');
  }

  now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  seed(title, body = '', labels = ['cinemagoal']) {
    const t = this.now();
    const issue = {
      number: this.nextNumber++, title, body, state: 'open', state_reason: null,
      labels: labels.map((name) => ({ name })), created_at: t, updated_at: t,
    };
    this.issues.push(issue);
    return issue;
  }

  handle({ method, url, headers = {}, body }) {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.requests.push({ method, path: u.pathname + u.search });
    const auth = h.authorization;
    const authed = auth === `Bearer ${this.token}`;
    const readOnly = auth === `Bearer ${this.readOnlyToken}`;
    if (auth && !authed && !readOnly) return this.json(401, { message: 'Bad credentials' });
    if (readOnly && method !== 'GET') return this.json(403, { message: 'Resource not accessible by personal access token' });
    if (!u.pathname.startsWith(`${this.prefix}/issues`)) return this.json(404, { message: 'Not Found' });
    const rest = u.pathname.slice(this.prefix.length);

    if (rest === '/issues' && method === 'GET') {
      const label = u.searchParams.get('labels');
      const stateQ = u.searchParams.get('state') || 'open';
      const per = Number(u.searchParams.get('per_page') || 30);
      const page = Number(u.searchParams.get('page') || 1);
      let list = this.issues.filter((i) => (!label || i.labels.some((l) => l.name === label))
        && (stateQ === 'all' || i.state === stateQ));
      list = list.sort((a, b) => (u.searchParams.get('sort') === 'updated'
        ? b.updated_at.localeCompare(a.updated_at) || b.number - a.number
        : b.number - a.number));
      const pageItems = list.slice((page - 1) * per, page * per);
      const payload = JSON.stringify(pageItems);
      const etag = `W/"${createHash('sha1').update(payload).digest('hex')}"`;
      if (h['if-none-match'] === etag) return { status: 304, headers: { etag }, body: '' };
      const extra = { etag };
      if (page * per < list.length) {
        const next = new URL(u);
        next.searchParams.set('page', String(page + 1));
        extra.link = `<${next}>; rel="next"`;
      }
      return { status: 200, headers: { 'content-type': 'application/json', ...extra }, body: payload };
    }

    if (method !== 'GET' && !authed) return this.json(401, { message: 'Requires authentication' });

    if (rest === '/issues' && method === 'POST') {
      const data = JSON.parse(body || '{}');
      const issue = this.seed(data.title, data.body || '', data.labels || []);
      return this.json(201, issue);
    }

    const m = /^\/issues\/(\d+)$/.exec(rest);
    if (m) {
      const issue = this.issues.find((i) => i.number === Number(m[1]));
      if (!issue) return this.json(404, { message: 'Not Found' });
      if (method === 'GET') return this.json(200, issue);
      if (method === 'PATCH') {
        const data = JSON.parse(body || '{}');
        for (const k of ['title', 'body', 'state', 'state_reason']) if (k in data) issue[k] = data[k];
        issue.updated_at = this.now();
        return this.json(200, issue);
      }
    }
    return this.json(404, { message: 'Not Found' });
  }

  json(status, obj) {
    return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
  }

  // fetch-compatible adapter for unit tests
  fetch = async (url, init = {}) => {
    const r = this.handle({ method: init.method || 'GET', url, headers: init.headers, body: init.body });
    return new Response(r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
  };
}

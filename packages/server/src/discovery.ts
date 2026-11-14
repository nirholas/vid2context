/**
 * Discovery for the site the Worker serves next to the API
 * (docs/guides/discovery.md):
 *
 * - Markdown for agents: a GET whose Accept header prefers text/markdown over
 *   text/html gets the page's `.md` twin (`/index.md`, `<path>.md`) when one
 *   exists, with `Vary: Accept`. Otherwise the HTML is served as usual.
 * - HTML responses carry `Vary: Accept` and a `Link` header pointing at
 *   llms.txt, the OpenAPI description and, when mounted, the MCP endpoint
 *   (RFC 8288, RFC 8631).
 *
 * Runtime-neutral: `fetchAsset` is the Workers ASSETS binding in production.
 */

export type FetchAsset = (req: Request) => Promise<Response>;

const MARKDOWN = 'text/markdown; charset=utf-8';

interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

function parseAccept(accept: string): MediaRange[] {
  return accept
    .split(',')
    .map((part) => {
      const [range = '', ...params] = part.trim().split(';');
      const [type = '', subtype = ''] = range.trim().toLowerCase().split('/');
      const qParam = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { type, subtype, q: Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 0 };
    })
    .filter((r) => r.type && r.subtype);
}

/** The q-value the Accept header gives one media type, from its most specific matching range (RFC 9110 section 12.5.1). */
function qualityOf(ranges: MediaRange[], type: string, subtype: string): number {
  const exact = ranges.find((r) => r.type === type && r.subtype === subtype);
  if (exact) return exact.q;
  const typeWild = ranges.find((r) => r.type === type && r.subtype === '*');
  if (typeWild) return typeWild.q;
  return ranges.find((r) => r.type === '*' && r.subtype === '*')?.q ?? 0;
}

/** True when the client ranks text/markdown strictly above text/html. Ties go to HTML (browsers send wildcards). */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const ranges = parseAccept(accept);
  const md = qualityOf(ranges, 'text', 'markdown');
  return md > 0 && md > qualityOf(ranges, 'text', 'html');
}

/** Candidate `.md` twins for a page path, most likely first. Paths that name a file (with an extension) have none. */
export function markdownTwins(pathname: string): string[] {
  if (pathname === '/' || pathname === '') return ['/index.md'];
  const last = pathname.split('/').filter(Boolean).pop() ?? '';
  if (last.includes('.')) return [];
  const base = pathname.replace(/\/+$/, '');
  return [`${base}.md`, `${base}/index.md`];
}

/**
 * True for paths the Hono app answers in the Worker: `/api` and `/api/*`,
 * plus `appPaths` (the mcp-http paths, when that sub-app is mounted).
 */
export function isAppPath(pathname: string, appPaths: ReadonlySet<string>): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || appPaths.has(pathname);
}

/** The Link header for HTML pages. */
export function linkHeader(opts: { mcp: boolean }): string {
  const links = [
    '</llms.txt>; rel="alternate"; type="text/plain"',
    '</api/v1/openapi.json>; rel="service-desc"; type="application/openapi+json"',
  ];
  if (opts.mcp) links.push('</mcp>; rel="service"');
  return links.join(', ');
}

function addVary(headers: Headers, value: string): void {
  const current = headers.get('vary');
  if (!current) headers.set('vary', value);
  else if (
    !current
      .toLowerCase()
      .split(/\s*,\s*/)
      .includes(value.toLowerCase())
  )
    headers.set('vary', `${current}, ${value}`);
}

/** Serve a site request with markdown negotiation, Vary and Link headers. */
export async function serveSite(req: Request, fetchAsset: FetchAsset, opts: { mcp: boolean }): Promise<Response> {
  const url = new URL(req.url);
  const negotiable = req.method === 'GET' || req.method === 'HEAD';
  if (negotiable && prefersMarkdown(req.headers.get('accept'))) {
    for (const twin of markdownTwins(url.pathname)) {
      const res = await fetchAsset(new Request(new URL(twin, url), { method: req.method, headers: req.headers }));
      if (res.ok) {
        const out = new Response(res.body, res);
        out.headers.set('content-type', MARKDOWN);
        addVary(out.headers, 'Accept');
        return out;
      }
    }
  }
  const res = await fetchAsset(req);
  if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) return res;
  const out = new Response(res.body, res);
  addVary(out.headers, 'Accept');
  out.headers.set('link', linkHeader(opts));
  return out;
}

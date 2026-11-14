/**
 * The owner's sign-in and consent page. Plain HTML with no scripts and no
 * third-party assets; the one inline style block is allowed by a per-response
 * nonce, so the Content-Security-Policy stays strict. `form-action` lists the
 * client's redirect origin because browsers apply it to the redirect that
 * follows the form post.
 */
import { randomToken } from './crypto.ts';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root{color-scheme:dark;--bg:#000;--surface:#0b0b0d;--border:#26262b;--text:#fafafa;--muted:#a1a1aa;--accent:#3b82f6;--accent2:#22d3ee;--danger:#ef4444}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
main{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:28px}
h1{font-size:20px;margin:0 0 4px}
p{color:var(--muted);margin:0 0 16px}
dl{margin:0 0 20px;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:14px}
dt{color:var(--muted)}
dd{margin:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
label{display:block;font-size:14px;margin-bottom:6px}
input[type=password]{width:100%;padding:12px 14px;border-radius:12px;border:1px solid var(--border);background:#000;color:var(--text);font-size:15px}
input[type=password]:focus{outline:2px solid var(--accent);outline-offset:1px}
.row{display:flex;gap:10px;margin-top:18px}
button{flex:1;padding:12px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:15px;cursor:pointer}
button.primary{border:0;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:600}
.error{color:var(--danger);margin:0 0 14px}
`;

export interface PageResult {
  html: string;
  headers: Record<string, string>;
}

function securityHeaders(nonce: string, formTargets: string[]): Record<string, string> {
  const formAction = ["'self'", ...formTargets].join(' ');
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

function layout(nonce: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export interface ConsentPageInput {
  requestId: string;
  csrf: string;
  clientName: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  error?: string;
}

export function consentPage(input: ConsentPageInput): PageResult {
  const nonce = randomToken(16);
  const redirect = new URL(input.redirectUri);
  const body = `<h1>Sign in to vid2context</h1>
<p><strong>${escapeHtml(input.clientName)}</strong> asks to use this vid2context server's tools.</p>
<dl>
<dt>Client</dt><dd>${escapeHtml(input.clientId)}</dd>
<dt>Returns to</dt><dd>${escapeHtml(redirect.origin)}</dd>
<dt>Access</dt><dd>${escapeHtml(input.scope)}</dd>
</dl>
${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(input.requestId)}">
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<label for="password">Owner password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<div class="row">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="approve" class="primary">Allow</button>
</div>
</form>`;
  return { html: layout(nonce, 'Sign in to vid2context', body), headers: securityHeaders(nonce, [redirect.origin]) };
}

export function messagePage(title: string, message: string): PageResult {
  const nonce = randomToken(16);
  const body = `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`;
  return { html: layout(nonce, title, body), headers: securityHeaders(nonce, []) };
}

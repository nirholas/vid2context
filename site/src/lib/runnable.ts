/**
 * Runnable examples: one typed spec per HTTP API request, turned into the
 * request itself, the matching curl, fetch, Python, CLI and MCP snippets, and
 * a readable view of the response. Runtime-neutral on purpose: the build uses
 * it to render each block and its Markdown twin, the browser uses it to
 * rebuild snippets as you edit and to run the request.
 */

// ------------------------------------------------------------------ specs

export type FieldType = 'url' | 'text' | 'select' | 'checkbox' | 'number' | 'list' | 'json' | 'file';

/** How a body or MCP value is encoded from the field's string. */
export type ValueKind = 'string' | 'number' | 'boolean' | 'list' | 'json';

export interface Field {
  /** Key in the values map, and the wire name unless `key` is set. */
  name: string;
  label: string;
  type: FieldType;
  /** Where the value goes: query string, a `{name}` path segment, the JSON body, or a multipart file. */
  in: 'query' | 'path' | 'body' | 'form';
  key?: string;
  /** Text default (checkbox: 'true' or ''). File fields have none. */
  default?: string;
  options?: string[];
  help?: string;
  /** Left out of the request when empty. */
  optional?: boolean;
  /** The server's own default: the field is left out of the request and the snippets while it has this value. */
  serverDefault?: string;
  /** CLI equivalent: a positional argument or a flag. Without it, setting the field hides the CLI snippet. */
  cli?: { positional?: true; flag?: string };
  /** MCP tool argument. Without it, setting the field hides the MCP snippet. */
  mcp?: { arg: string };
  /** Take the value from an earlier block on the page that `provides` this name. */
  from?: string;
}

export interface FileSample {
  /** Site path of a real sample file. */
  href: string;
  name: string;
  label: string;
  /** Repo path, read by the recorder. */
  repoPath: string;
}

export interface RunnableSpec {
  id: string;
  title: string;
  method: 'GET' | 'POST';
  path: string;
  fields: Field[];
  /** Constant body keys sent with every request (for example `stream: true`). */
  fixedBody?: Record<string, unknown>;
  /** What the success body is, for the snippets and the viewer. */
  response: 'text' | 'json' | 'zip' | 'sse';
  /** A POST that may answer `202` with a Job: the runner polls `/api/v1/jobs/{id}`. */
  job?: boolean;
  cli?: { command: string[]; extra?: string[] };
  mcp?: { tool: string; fixed?: Record<string, unknown> };
  /** Share a value from the JSON response (a dotted path) with later blocks under this name. */
  provides?: { name: string; path: string };
  sample?: FileSample;
  /** One line under the title. */
  note?: string;
}

export type Values = Record<string, string>;

export function defaults(spec: RunnableSpec): Values {
  const v: Values = {};
  for (const f of spec.fields) if (f.type !== 'file') v[f.name] = f.default ?? '';
  return v;
}

const wire = (f: Field) => f.key ?? f.name;

function kindOf(f: Field): ValueKind {
  if (f.type === 'checkbox') return 'boolean';
  if (f.type === 'number') return 'number';
  if (f.type === 'list') return 'list';
  if (f.type === 'json') return 'json';
  return 'string';
}

/** True when the field contributes nothing (empty text, unchecked box, empty list, or its server default). */
function isEmpty(f: Field, raw: string): boolean {
  if (f.serverDefault !== undefined && raw === f.serverDefault) return true;
  if (f.type === 'checkbox') return raw !== 'true';
  if (f.type === 'list') return splitList(raw).length === 0;
  return raw.trim() === '';
}

export function splitList(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export class InputError extends Error {}

/** A field value as JSON (body and MCP arguments). */
function typed(f: Field, raw: string): unknown {
  switch (kindOf(f)) {
    case 'boolean':
      return raw === 'true';
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new InputError(`${f.label} must be a number.`);
      return n;
    }
    case 'list':
      return splitList(raw);
    case 'json':
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new InputError(`${f.label} is not valid JSON: ${(err as Error).message}`);
      }
    default:
      return raw.trim();
  }
}

// ------------------------------------------------------------------ requests

export interface BuiltRequest {
  method: 'GET' | 'POST';
  /** Path with the path segments filled in, no query. */
  path: string;
  query: [string, string][];
  json?: Record<string, unknown>;
  /** The multipart file field, when the request uploads a file. */
  file?: { field: string; name: string };
}

export function buildRequest(spec: RunnableSpec, values: Values, fileName?: string): BuiltRequest {
  let path = spec.path;
  const query: [string, string][] = [];
  let json: Record<string, unknown> | undefined;
  let file: BuiltRequest['file'];
  for (const f of spec.fields) {
    if (f.in === 'form') {
      file = { field: wire(f), name: fileName ?? spec.sample?.name ?? 'file' };
      continue;
    }
    const raw = values[f.name] ?? '';
    const empty = isEmpty(f, raw);
    if (empty && !f.optional && f.serverDefault === undefined && f.type !== 'checkbox') throw new InputError(`${f.label} is required.`);
    if (f.in === 'path') {
      path = path.replace(`{${wire(f)}}`, encodeURIComponent(raw.trim()));
      continue;
    }
    if (empty) continue;
    if (f.in === 'query') query.push([wire(f), f.type === 'checkbox' ? '1' : raw.trim()]);
    else {
      json ??= {};
      json[wire(f)] = typed(f, raw);
    }
  }
  if (spec.fixedBody) json = { ...(json ?? {}), ...spec.fixedBody };
  if (spec.method === 'POST' && !json && !file) json = {};
  return { method: spec.method, path, query, ...(json ? { json } : {}), ...(file ? { file } : {}) };
}

/** `?a=1&b=2`, or '' without a query. */
export function queryString(query: [string, string][]): string {
  if (!query.length) return '';
  return `?${query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

export function requestUrl(base: string, req: BuiltRequest): string {
  return `${base.replace(/\/+$/, '')}${req.path}${queryString(req.query)}`;
}

// ------------------------------------------------------------------ snippets

export interface SnippetOptions {
  /** API origin shown in the snippets, no trailing slash. */
  base: string;
  /** Add an Authorization header that reads the key from the environment. */
  auth: boolean;
  /** How the CLI is started: `npx -y vid2context` or `npm run -s cli --`. */
  cliPrefix: string;
}

export type SnippetLang = 'bash' | 'js' | 'python' | 'json';

export interface Snippet {
  id: 'curl' | 'fetch' | 'python' | 'cli' | 'mcp';
  label: string;
  lang: SnippetLang;
  code: string;
}

const KEY_ENV = 'VID2CONTEXT_API_KEY';

/** Single-quote for a POSIX shell when the word needs it. */
export function shq(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function zipName(spec: RunnableSpec): string {
  return `${spec.id}.zip`;
}

export function curlSnippet(spec: RunnableSpec, req: BuiltRequest, o: SnippetOptions): string {
  const url = `${o.base}${req.path}`;
  const lines: string[] = [];
  const head = ['curl'];
  if (spec.response === 'sse') head.push('-N');
  if (spec.response === 'zip') head.push('-OJ');
  if (req.method === 'GET' && req.query.length) head.push('-G');
  head.push(shq(url));
  lines.push(head.join(' '));
  if (o.auth) lines.push(`-H "Authorization: Bearer $${KEY_ENV}"`);
  for (const [k, v] of req.query) lines.push(`--data-urlencode ${shq(`${k}=${v}`)}`);
  if (req.file) lines.push(`-F ${shq(`${req.file.field}=@${req.file.name}`)}`);
  else if (req.json) {
    lines.push(`-H 'Content-Type: application/json'`);
    lines.push(`-d ${shq(JSON.stringify(req.json, null, 2))}`);
  }
  return lines.join(' \\\n  ');
}

function jsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/** A JSON value as a JavaScript literal, keys unquoted when they can be. */
function jsLiteral(v: unknown, indent = ''): string {
  const next = `${indent}  `;
  if (v === null) return 'null';
  if (typeof v === 'string') return jsString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => `${next}${jsLiteral(x, next)},`).join('\n')}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : jsString(k));
  return `{\n${entries.map(([k, x]) => `${next}${key(k)}: ${jsLiteral(x, next)},`).join('\n')}\n${indent}}`;
}

export function fetchSnippet(spec: RunnableSpec, req: BuiltRequest, o: SnippetOptions): string {
  const out: string[] = [];
  const zip = spec.response === 'zip';
  if (zip || req.file) out.push(`import { ${[req.file ? 'readFile' : '', zip ? 'writeFile' : ''].filter(Boolean).join(', ')} } from 'node:fs/promises';`, '');
  out.push(`const BASE = ${jsString(o.base)};`);
  const headers: string[] = [];
  if (o.auth) headers.push(`Authorization: \`Bearer \${process.env.${KEY_ENV}}\``);
  let target = `\`\${BASE}${req.path}\``;
  if (req.query.length) {
    out.push(`const params = new URLSearchParams(${jsLiteral(Object.fromEntries(req.query))});`);
    target = `\`\${BASE}${req.path}?\${params}\``;
  }
  const init: string[] = [];
  if (req.method !== 'GET') init.push(`method: '${req.method}'`);
  if (req.file) {
    out.push('const form = new FormData();');
    out.push(
      `form.append(${jsString(req.file.field)}, new Blob([await readFile(${jsString(req.file.name)})]), ${jsString(req.file.name)});`,
    );
    init.push('body: form');
  } else if (req.json) {
    headers.unshift(`'Content-Type': 'application/json'`);
    out.push(`const body = ${jsLiteral(req.json)};`);
    init.push('body: JSON.stringify(body)');
  }
  if (headers.length) init.unshift(`headers: { ${headers.join(', ')} }`);
  out.push(init.length ? `const res = await fetch(${target}, {\n  ${init.join(',\n  ')},\n});` : `const res = await fetch(${target});`);
  out.push(
    'if (!res.ok) {',
    '  const { error } = await res.json();',
    "  throw new Error(`${error.code}: ${error.message} ${error.hint ?? ''}`);",
    '}',
  );
  if (spec.job) {
    const auth = o.auth ? `, { headers: { Authorization: \`Bearer \${process.env.${KEY_ENV}}\` } }` : '';
    out.push(
      '// With a jobs queue the server answers 202 and a Job; poll it until it finishes.',
      'let job = res.status === 202 ? await res.json() : { status: "succeeded", result: await res.json() };',
      "while (job.status === 'queued' || job.status === 'running') {",
      '  await new Promise((r) => setTimeout(r, 2000));',
      `  job = await (await fetch(\`\${BASE}/api/v1/jobs/\${job.id}\`${auth})).json();`,
      '}',
      'console.log(JSON.stringify(job.result ?? job.error, null, 2));',
    );
  } else if (spec.response === 'json') out.push('console.log(JSON.stringify(await res.json(), null, 2));');
  else if (zip) {
    out.push(
      `await writeFile(${jsString(zipName(spec))}, Buffer.from(await res.arrayBuffer()));`,
      `console.log('Saved ${zipName(spec)}');`,
    );
  } else if (spec.response === 'sse') {
    out.push(
      '// Server-sent events: print the answer as it arrives.',
      'const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();',
      "let buffer = '';",
      'for (;;) {',
      '  const { value, done } = await reader.read();',
      '  if (done) break;',
      '  buffer += value;',
      '  let end = buffer.indexOf(\'\\n\\n\');',
      '  while (end >= 0) {',
      '    const block = buffer.slice(0, end);',
      '    buffer = buffer.slice(end + 2);',
      '    const event = /^event: (.*)$/m.exec(block)?.[1];',
      '    const data = /^data: (.*)$/m.exec(block)?.[1];',
      "    if (event === 'delta') process.stdout.write(JSON.parse(data).text);",
      "    if (event === 'error') throw new Error(JSON.parse(data).message);",
      '    end = buffer.indexOf(\'\\n\\n\');',
      '  }',
      '}',
    );
  } else out.push('console.log(await res.text());');
  return out.join('\n');
}

function pyString(s: string): string {
  return JSON.stringify(s);
}

function pyLiteral(v: unknown, indent = ''): string {
  const next = `${indent}    `;
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return pyString(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => `${next}${pyLiteral(x, next)},`).join('\n')}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return '{}';
  return `{\n${entries.map(([k, x]) => `${next}${pyString(k)}: ${pyLiteral(x, next)},`).join('\n')}\n${indent}}`;
}

export function pythonSnippet(spec: RunnableSpec, req: BuiltRequest, o: SnippetOptions): string {
  const imports = new Set(['json', 'urllib.error', 'urllib.request']);
  if (req.query.length) imports.add('urllib.parse');
  if (o.auth) imports.add('os');
  if (spec.job) imports.add('time');
  if (req.file) imports.add('uuid');
  const out: string[] = [
    ...[...imports].sort().map((m) => `import ${m}`),
    '',
    `BASE = ${pyString(o.base)}`,
  ];
  const headers: string[] = [];
  if (o.auth) headers.push(`"Authorization": f"Bearer {os.environ['${KEY_ENV}']}"`);
  let url = `f"{BASE}${req.path}"`;
  if (req.query.length) {
    out.push(`params = urllib.parse.urlencode(${pyLiteral(Object.fromEntries(req.query))})`);
    url = `f"{BASE}${req.path}?{params}"`;
  }
  let data = '';
  if (req.file) {
    out.push(
      'boundary = uuid.uuid4().hex',
      `with open(${pyString(req.file.name)}, "rb") as f:`,
      '    payload = f.read()',
      'data = (',
      `    f'--{boundary}\\r\\nContent-Disposition: form-data; name="${req.file.field}"; filename="${req.file.name}"\\r\\n'`,
      "    'Content-Type: application/octet-stream\\r\\n\\r\\n'",
      `).encode() + payload + f"\\r\\n--{boundary}--\\r\\n".encode()`,
    );
    headers.unshift('"Content-Type": f"multipart/form-data; boundary={boundary}"');
    data = ', data=data';
  } else if (req.json) {
    out.push(`body = ${pyLiteral(req.json)}`);
    headers.unshift('"Content-Type": "application/json"');
    data = ', data=json.dumps(body).encode()';
  }
  const method = req.method === 'GET' ? '' : `, method="${req.method}"`;
  out.push(`headers = {${headers.join(', ')}}`);
  out.push(`req = urllib.request.Request(${url}${data}, headers=headers${method})`);
  out.push('', 'try:', '    with urllib.request.urlopen(req, timeout=300) as res:');
  if (spec.job) {
    out.push(
      '        status = res.status',
      '        answer = json.load(res)',
      'except urllib.error.HTTPError as err:',
      '    error = json.load(err)["error"]',
      `    raise SystemExit(f"{error['code']}: {error['message']} {error.get('hint', '')}")`,
      '',
      '# With a jobs queue the server answers 202 and a Job; poll it until it finishes.',
      'job = answer if status == 202 else {"status": "succeeded", "result": answer}',
      'while job["status"] in ("queued", "running"):',
      '    time.sleep(2)',
      `    poll = urllib.request.Request(f"{BASE}/api/v1/jobs/{job['id']}"${o.auth ? ', headers=headers' : ''})`,
      '    with urllib.request.urlopen(poll, timeout=60) as res:',
      '        job = json.load(res)',
      'print(json.dumps(job.get("result") or job.get("error"), indent=2))',
    );
    return out.join('\n');
  }
  if (spec.response === 'json') out.push('        print(json.dumps(json.load(res), indent=2))');
  else if (spec.response === 'zip') {
    out.push(
      `        with open(${pyString(zipName(spec))}, "wb") as f:`,
      '            f.write(res.read())',
      `        print("Saved ${zipName(spec)}")`,
    );
  } else if (spec.response === 'sse') {
    out.push(
      '        event = None',
      '        for raw in res:',
      '            line = raw.decode().rstrip("\\n")',
      '            if line.startswith("event: "):',
      '                event = line[7:]',
      '            elif line.startswith("data: ") and event == "delta":',
      '                print(json.loads(line[6:])["text"], end="", flush=True)',
    );
  } else out.push('        print(res.read().decode())');
  out.push(
    'except urllib.error.HTTPError as err:',
    '    error = json.load(err)["error"]',
    `    raise SystemExit(f"{error['code']}: {error['message']} {error.get('hint', '')}")`,
  );
  return out.join('\n');
}

/** The CLI command, or null when a set field has no CLI equivalent. */
export function cliSnippet(spec: RunnableSpec, values: Values, o: SnippetOptions): string | null {
  if (!spec.cli) return null;
  const words: string[] = [...spec.cli.command];
  for (const f of spec.fields) {
    const raw = values[f.name] ?? '';
    if (f.type === 'file') {
      if (!f.cli) return null;
      words.push(spec.sample?.name ?? 'file');
      continue;
    }
    if (isEmpty(f, raw)) continue;
    if (!f.cli) return null;
    const vals = f.type === 'list' ? splitList(raw) : [raw.trim()];
    if (f.cli.positional) words.push(...vals.map(shq));
    else if (f.cli.flag) {
      if (f.type === 'checkbox') words.push(f.cli.flag);
      else for (const v of vals) words.push(f.cli.flag, shq(v));
    }
  }
  words.push(...(spec.cli.extra ?? []));
  return `${o.cliPrefix} ${words.join(' ')}`;
}

/** The MCP `tools/call` params, or null when a set field has no MCP argument. */
export function mcpSnippet(spec: RunnableSpec, values: Values): string | null {
  if (!spec.mcp) return null;
  const args: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const raw = values[f.name] ?? '';
    if (f.type === 'file' || isEmpty(f, raw)) continue;
    if (!f.mcp) return null;
    try {
      args[f.mcp.arg] = typed(f, raw);
    } catch {
      return null;
    }
  }
  Object.assign(args, spec.mcp.fixed ?? {});
  return JSON.stringify({ name: spec.mcp.tool, arguments: args }, null, 2);
}

/** Every snippet that applies to these values. Throws InputError when a value cannot be sent. */
export function snippets(spec: RunnableSpec, values: Values, o: SnippetOptions, fileName?: string): Snippet[] {
  const req = buildRequest(spec, values, fileName);
  const list: Snippet[] = [
    { id: 'curl', label: 'curl', lang: 'bash', code: curlSnippet(spec, req, o) },
    { id: 'fetch', label: 'JavaScript', lang: 'js', code: fetchSnippet(spec, req, o) },
    { id: 'python', label: 'Python', lang: 'python', code: pythonSnippet(spec, req, o) },
  ];
  const cli = cliSnippet(spec, values, o);
  if (cli) list.push({ id: 'cli', label: 'CLI', lang: 'bash', code: cli });
  const mcp = mcpSnippet(spec, values);
  if (mcp) list.push({ id: 'mcp', label: 'MCP tool call', lang: 'json', code: mcp });
  return list;
}

// ------------------------------------------------------------------ highlighting

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export function escapeHtml(s: string): string {
  return esc(s);
}

interface Rule {
  re: RegExp;
  cls: string | ((m: RegExpExecArray, src: string, at: number) => string);
}

const JS_KW =
  /^(?:const|let|var|await|async|new|if|else|for|while|break|continue|of|in|throw|return|import|from|function|try|catch|true|false|null|undefined)$/;
const PY_KW =
  /^(?:import|from|as|with|try|except|raise|if|elif|else|while|for|in|not|and|or|def|return|True|False|None|print)$/;

const RULES: Record<SnippetLang, Rule[]> = {
  bash: [
    { re: /#[^\n]*/y, cls: 'com' },
    { re: /'[^']*'/y, cls: 'str' },
    { re: /"(?:[^"\\]|\\.)*"/y, cls: 'str' },
    { re: /\$[A-Za-z_][A-Za-z0-9_]*/y, cls: 'var' },
    { re: /(?<![\w-])--?[A-Za-z][\w-]*/y, cls: 'flag' },
    { re: /(?<=^|\n)[A-Za-z][\w.-]*/y, cls: 'fn' },
  ],
  js: [
    { re: /\/\/[^\n]*/y, cls: 'com' },
    { re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/y, cls: 'str' },
    { re: /\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuy]*/y, cls: 'str' },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: 'num' },
    {
      re: /[A-Za-z_$][\w$]*/y,
      cls: (m, src, at) => (JS_KW.test(m[0]) ? 'kw' : src[at + m[0].length] === '(' ? 'fn' : ''),
    },
  ],
  python: [
    { re: /#[^\n]*/y, cls: 'com' },
    { re: /[fb]?'(?:[^'\\\n]|\\.)*'|[fb]?"(?:[^"\\\n]|\\.)*"/y, cls: 'str' },
    { re: /\b\d+(?:\.\d+)?\b/y, cls: 'num' },
    {
      re: /[A-Za-z_][\w]*/y,
      cls: (m, src, at) => (PY_KW.test(m[0]) ? 'kw' : src[at + m[0].length] === '(' ? 'fn' : ''),
    },
  ],
  json: [
    { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, cls: 'key' },
    { re: /"(?:[^"\\]|\\.)*"/y, cls: 'str' },
    { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'num' },
    { re: /\b(?:true|false|null)\b/y, cls: 'kw' },
  ],
};

/** A small highlighter for the snippets, so the build and the browser color code the same way. */
export function highlightCode(code: string, lang: SnippetLang | 'text'): string {
  if (lang === 'text') return esc(code);
  const rules = RULES[lang];
  let out = '';
  let plain = '';
  let i = 0;
  outer: while (i < code.length) {
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (!m || m[0].length === 0) continue;
      const cls = typeof rule.cls === 'function' ? rule.cls(m, code, i) : rule.cls;
      if (!cls) {
        plain += m[0];
      } else {
        out += esc(plain);
        plain = '';
        out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
      }
      i += m[0].length;
      continue outer;
    }
    plain += code[i];
    i++;
  }
  return out + esc(plain);
}

// ------------------------------------------------------------------ responses

export interface SseEvent {
  event: string;
  data: string;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return events;
}

/** The answer text and a summary of an `/ask` stream (meta, deltas, done, error). */
export function presentSse(text: string): string {
  const events = parseSse(text);
  let answer = '';
  const lines: string[] = [];
  for (const ev of events) {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      lines.push(`${ev.event}: ${ev.data}`);
      continue;
    }
    if (ev.event === 'meta') {
      if (data.restart) answer = '';
      const sources = Array.isArray(data.sources) ? data.sources.length : 0;
      lines.push(`meta: ${data.rung} (${sources} source${sources === 1 ? '' : 's'}, about ${data.promptTokens} prompt tokens)`);
    } else if (ev.event === 'delta') answer += String(data.text ?? '');
    else if (ev.event === 'done') {
      const cites = Array.isArray(data.citations) ? data.citations.length : 0;
      lines.push(`done: ${cites} citation${cites === 1 ? '' : 's'} verified`);
      if (typeof data.text === 'string' && data.text) answer = data.text;
    } else if (ev.event === 'error') lines.push(`error: ${data.code}: ${data.message}${data.hint ? ` (${data.hint})` : ''}`);
  }
  return `${events.length} events\n${lines.join('\n')}\n\n${answer}`.trim();
}

export interface ZipEntry {
  name: string;
  size: number;
}

/** File names and sizes from a zip's central directory. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && view.getUint32(at, true) === 0x02014b50; n++) {
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    entries.push({ name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)), size });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function presentZip(bytes: Uint8Array): string {
  const entries = zipEntries(bytes);
  const width = Math.max(...entries.map((e) => String(e.size).length));
  return `${entries.length} files, ${bytes.length} bytes\n\n${entries
    .map((e) => `${String(e.size).padStart(width)}  ${e.name}`)
    .join('\n')}`;
}

/** Text bodies as they are, JSON pretty-printed. */
export function presentText(contentType: string, text: string): { text: string; lang: SnippetLang | 'text' } {
  if (/json/.test(contentType)) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), lang: 'json' };
    } catch {
      return { text, lang: 'text' };
    }
  }
  if (/event-stream/.test(contentType)) return { text: presentSse(text), lang: 'text' };
  return { text, lang: 'text' };
}

/** Base64 to bytes without Node's Buffer. */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Response headers worth showing next to a result. */
export const SHOWN_HEADERS = [
  'content-type',
  'x-request-id',
  'x-translated-via',
  'x-data-attribution',
  'etag',
  'content-disposition',
  'x-ratelimit-remaining',
  'retry-after',
] as const;

// ------------------------------------------------------------------ recorded responses

/** A real response recorded from a running server by scripts/record-runnables.ts. */
export interface Recording {
  id: string;
  /** ISO date of the recording. */
  recordedAt: string;
  server: { name: string; version: string; runtime: string };
  request: { method: string; path: string; query: [string, string][]; json?: unknown; file?: { field: string; name: string } };
  status: number;
  ms: number;
  headers: Record<string, string>;
  /** Text bodies (JSON, text, SSE). */
  body?: string;
  /** Binary bodies (zip), base64. */
  bodyBase64?: string;
  /** When the POST answered 202: the polls until the job finished, and the final job. */
  job?: { polls: number; final: unknown };
}

/** What the viewer shows for a recording. */
export function presentRecording(rec: Recording): { text: string; lang: SnippetLang | 'text' } {
  if (rec.job) return { text: JSON.stringify(rec.job.final, null, 2), lang: 'json' };
  if (rec.bodyBase64) return { text: presentZip(fromBase64(rec.bodyBase64)), lang: 'text' };
  return presentText(rec.headers['content-type'] ?? '', rec.body ?? '');
}

/** Clip long output for the page and the twin; the rest is a run away. */
export function clipOutput(text: string, maxLines: number, maxChars: number): { text: string; clipped: number } {
  const lines = text.split('\n');
  let kept = lines.slice(0, maxLines).join('\n');
  if (kept.length > maxChars) kept = kept.slice(0, kept.lastIndexOf('\n', maxChars) > 0 ? kept.lastIndexOf('\n', maxChars) : maxChars);
  const keptLines = kept.split('\n').length;
  return { text: kept, clipped: lines.length - keptLines };
}

/** 850 ms, 1.2 s, 80.5 s. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

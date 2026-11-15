/**
 * A small streaming XML parser for podcast feeds. It runs on Node and Workers
 * alike: no Node built-ins and no DOM. It is not a validating parser; it reads
 * what real feeds contain (an XML declaration, processing instructions such
 * as xml-stylesheet, comments, a DOCTYPE, CDATA sections, entities and
 * namespaces) and tolerates the common mistakes (unclosed or mismatched end
 * tags, HTML entities in text).
 *
 * Element names are rewritten to canonical prefixes by namespace URI, so a
 * feed that binds the Podcasting 2.0 namespace to `pc:` (or to either of its
 * two published URIs) still yields `podcast:transcript`. Atom elements become
 * `atom:*` whether Atom is the default namespace or a prefixed one.
 *
 * Feed it text with `write(chunk)`; elements the `detach` callback accepts
 * (feed items) are returned from `write` as soon as they close and are not
 * kept in the tree, so a feed with thousands of episodes streams in constant
 * memory per item.
 */
import { decodeEntities } from '@vid2context/core';

export interface XmlElement {
  /** Canonical name: 'title', 'itunes:duration', 'podcast:transcript', 'atom:entry'. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Direct text and CDATA content, entities decoded. */
  text: string;
}

const NAMESPACES: [RegExp, string][] = [
  [/^https?:\/\/www\.itunes\.com\/dtds\/podcast-1\.0\.dtd$/i, 'itunes'],
  [/podcastindex|podcast-namespace/i, 'podcast'],
  [/^https?:\/\/purl\.org\/rss\/1\.0\/modules\/content\/?$/i, 'content'],
  [/^https?:\/\/www\.w3\.org\/2005\/Atom\/?$/i, 'atom'],
  [/^https?:\/\/search\.yahoo\.com\/mrss\/?$/i, 'media'],
  [/^https?:\/\/podlove\.org\/simple-chapters\/?$/i, 'psc'],
  [/^https?:\/\/www\.google\.com\/schemas\/play-podcasts\/1\.0\/?$/i, 'googleplay'],
  [/^https?:\/\/purl\.org\/dc\/elements\/1\.1\/?$/i, 'dc'],
  [/^https?:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#?$/i, 'rdf'],
];

function canonicalPrefix(uri: string): string | undefined {
  for (const [re, prefix] of NAMESPACES) if (re.test(uri)) return prefix;
  return undefined;
}

interface Frame {
  el: XmlElement;
  /** The name as written, for matching the end tag. */
  raw: string;
  ns: Record<string, string>;
}

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export class XmlStreamParser {
  private buf = '';
  private readonly stack: Frame[] = [];
  private rootEl: XmlElement | undefined;

  constructor(private readonly detach: (el: XmlElement, parents: readonly XmlElement[]) => boolean = () => false) {}

  /** The document element once its start tag has been read. */
  get root(): XmlElement | undefined {
    return this.rootEl;
  }

  /** Open elements, outermost first. */
  get open(): readonly XmlElement[] {
    return this.stack.map((f) => f.el);
  }

  /** Parse as much of the text as is complete; returns detached elements in document order. */
  write(chunk: string): XmlElement[] {
    this.buf += chunk;
    return this.run(false);
  }

  /** Flush the rest of the input and close every open element. */
  end(): XmlElement[] {
    const out = this.run(true);
    while (this.stack.length > 0) this.close(out);
    return out;
  }

  private run(final: boolean): XmlElement[] {
    const out: XmlElement[] = [];
    const s = this.buf;
    let pos = 0;
    while (pos < s.length) {
      const lt = s.indexOf('<', pos);
      if (lt !== pos) {
        if (lt === -1 && !final) break;
        const end = lt === -1 ? s.length : lt;
        this.text(decodeEntities(s.slice(pos, end)));
        pos = end;
        continue;
      }
      const consumed = this.markup(s, pos, out);
      if (consumed === -1) {
        if (!final) break;
        // Unterminated markup at the end of the input: treat the rest as text.
        this.text(s.slice(pos));
        pos = s.length;
        break;
      }
      pos = consumed;
    }
    this.buf = s.slice(pos);
    return out;
  }

  /** Handle the markup starting at `pos` (a '<'); returns the index after it, or -1 when incomplete. */
  private markup(s: string, pos: number, out: XmlElement[]): number {
    if (s.startsWith('<!--', pos)) {
      const end = s.indexOf('-->', pos + 4);
      return end === -1 ? -1 : end + 3;
    }
    if (s.startsWith('<![CDATA[', pos)) {
      const end = s.indexOf(']]>', pos + 9);
      if (end === -1) return -1;
      this.text(s.slice(pos + 9, end));
      return end + 3;
    }
    if (s.startsWith('<?', pos)) {
      const end = s.indexOf('?>', pos + 2);
      return end === -1 ? -1 : end + 2;
    }
    if (s.startsWith('<!', pos)) {
      // DOCTYPE, possibly with an internal subset in brackets.
      const gt = s.indexOf('>', pos);
      if (gt === -1) return -1;
      const bracket = s.indexOf('[', pos);
      if (bracket !== -1 && bracket < gt) {
        const end = s.indexOf(']>', bracket);
        return end === -1 ? -1 : end + 2;
      }
      return gt + 1;
    }
    if (s.length < pos + 2) return -1;
    if (s[pos + 1] === '/') {
      const gt = s.indexOf('>', pos);
      if (gt === -1) return -1;
      this.endTag(s.slice(pos + 2, gt).trim(), out);
      return gt + 1;
    }
    // Start tag: find the closing '>' outside quoted attribute values.
    let quote = '';
    let i = pos + 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (i >= s.length) return -1;
    const body = s.slice(pos + 1, i);
    const selfClosing = body.endsWith('/');
    this.startTag(selfClosing ? body.slice(0, -1) : body, selfClosing, out);
    return i + 1;
  }

  private text(t: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top) top.el.text += t;
  }

  private startTag(body: string, selfClosing: boolean, out: XmlElement[]): void {
    const m = /^\s*([^\s/>]+)/.exec(body);
    if (!m?.[1]) return;
    const raw = m[1];
    const rawAttrs: Record<string, string> = {};
    const rest = body.slice(m[0].length);
    for (const a of rest.matchAll(ATTR)) {
      if (!a[1]) continue;
      rawAttrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    const parent = this.stack[this.stack.length - 1];
    const ns: Record<string, string> = { ...(parent?.ns ?? {}) };
    for (const [k, v] of Object.entries(rawAttrs)) {
      if (k === 'xmlns') ns[''] = v;
      else if (k.startsWith('xmlns:')) ns[k.slice(6)] = v;
    }
    const colon = raw.indexOf(':');
    const prefix = colon === -1 ? '' : raw.slice(0, colon);
    const local = colon === -1 ? raw : raw.slice(colon + 1);
    const uri = ns[prefix];
    const canon = uri ? canonicalPrefix(uri) : undefined;
    const name = canon ? `${canon}:${local}` : uri === undefined || prefix ? raw : local;
    const el: XmlElement = { name, attrs: rawAttrs, children: [], text: '' };
    if (parent) parent.el.children.push(el);
    else this.rootEl ??= el;
    this.stack.push({ el, raw, ns });
    if (selfClosing) this.close(out);
  }

  private endTag(raw: string, out: XmlElement[]): void {
    // Close up to the matching open element; ignore stray end tags.
    let idx = -1;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]?.raw === raw) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    while (this.stack.length > idx) this.close(out);
  }

  private close(out: XmlElement[]): void {
    const frame = this.stack.pop();
    if (!frame) return;
    const parents = this.stack.map((f) => f.el);
    if (this.detach(frame.el, parents)) {
      const parent = parents[parents.length - 1];
      if (parent) parent.children.splice(parent.children.lastIndexOf(frame.el), 1);
      out.push(frame.el);
    }
  }
}

/** Parse a whole document; returns the root element. */
export function parseXml(text: string): XmlElement | undefined {
  const p = new XmlStreamParser();
  p.write(text);
  p.end();
  return p.root;
}

/** Local part of a canonical name: 'atom:entry' to 'entry'. */
export function localName(name: string): string {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

export function childrenNamed(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** Trimmed text of the first child with one of the names, or undefined when empty. */
export function textOf(el: XmlElement | undefined, ...names: string[]): string | undefined {
  for (const n of names) {
    const t = child(el, n)?.text.trim();
    if (t) return t;
  }
  return undefined;
}

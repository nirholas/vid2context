/**
 * Assistant Markdown, loaded on demand (React.lazy) so the renderer is not in
 * the initial bundle. react-markdown never renders raw HTML (no rehype-raw)
 * and its URL transform drops javascript: and other unsafe links, so model
 * output cannot inject markup. GitHub-flavored Markdown adds tables and
 * strikethrough. A small remark plugin turns [n] markers into citation chips
 * outside code and links. Code blocks get a copy button; tables scroll.
 */
import { Check, Copy } from 'lucide-react';
import { Children, isValidElement, type ReactNode, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitCitations } from '../lib/citations.ts';
import { CitationGroup } from './CitationChip.tsx';
import { copyText } from './ui.tsx';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html']);

/** remark plugin: split text nodes on [n] markers into `v2c-cite` elements. */
export function remarkCitations() {
  const walk = (node: MdNode) => {
    if (!node.children || SKIP.has(node.type)) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && child.value && /\[\d|\u3010\d/.test(child.value)) {
        for (const part of splitCitations(child.value)) {
          if (part.kind === 'text') next.push({ type: 'text', value: part.text });
          else
            next.push({
              type: 'v2cCite',
              data: { hName: 'v2c-cite', hProperties: { dataNs: part.ns.join(','), dataRaw: part.raw } },
              children: [{ type: 'text', value: part.raw }],
            });
        }
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function CodeBlock(props: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(props.children)[0];
  const className = isValidElement<{ className?: string }>(child) ? (child.props.className ?? '') : '';
  const lang = /language-([\w+-]+)/.exec(className)?.[1];
  const code = textOf(props.children).replace(/\n$/, '');
  return (
    <div className="group relative my-3 overflow-hidden rounded-md border border-border bg-surface-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-muted">
        <span className="font-mono">{lang ?? 'text'}</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-surface-3 hover:text-fg"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="v2c-scroll m-0 overflow-x-auto p-3 font-mono text-[0.85em] leading-relaxed">{props.children}</pre>
    </div>
  );
}

const components = {
  pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="v2c-scroll my-3 overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  'v2c-cite': (props: { 'data-ns'?: string; 'data-raw'?: string }) => {
    const ns = (props['data-ns'] ?? '')
      .split(',')
      .map((n) => Number.parseInt(n, 10))
      .filter(Number.isFinite);
    return <CitationGroup ns={ns} raw={props['data-raw'] ?? ''} />;
  },
} as unknown as Components;

const remarkPlugins = [remarkGfm, remarkCitations];

export default function Markdown(props: { text: string }) {
  return (
    <div className="v2c-md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {props.text}
      </ReactMarkdown>
    </div>
  );
}

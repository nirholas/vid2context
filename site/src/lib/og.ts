/**
 * Open Graph images rendered at build time: satori lays out the card with the
 * self-hosted Inter files and turns text into paths, sharp rasterizes it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';
import sharp from 'sharp';
import { repoPath } from './paths.ts';

const require = createRequire(import.meta.url);
const font = (file: string) => readFileSync(require.resolve(`@fontsource/inter/files/${file}`));
const fonts = [
  { name: 'Inter', data: font('inter-latin-400-normal.woff'), weight: 400 as const, style: 'normal' as const },
  { name: 'Inter', data: font('inter-latin-700-normal.woff'), weight: 700 as const, style: 'normal' as const },
];
const logo = `data:image/svg+xml;base64,${Buffer.from(readFileSync(repoPath('packages/discovery/assets/logo.svg'), 'utf8')).toString('base64')}`;

type El = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): El => ({
  type,
  props: { style, children, ...extra },
});

/**
 * One card. Default 1200x630 (Open Graph); the GitHub social preview uses 1280x640 (scripts/social-preview.ts).
 * `footer` replaces the bottom-left line, which defaults to the site address.
 */
export async function ogImage(opts: {
  title: string;
  description: string;
  kicker: string;
  width?: number;
  height?: number;
  footer?: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 630;
  const title = opts.title.length > 90 ? `${opts.title.slice(0, 87).replace(/\s+\S*$/, '')}...` : opts.title;
  const description =
    opts.description.length > 150 ? `${opts.description.slice(0, 147).replace(/\s+\S*$/, '')}...` : opts.description;
  const tree = h(
    'div',
    {
      width,
      height,
      // Padding inside the card's size, not added to it (without this the right margin and the footer fell off).
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '64px 72px',
      background: '#000000',
      backgroundImage: 'radial-gradient(900px 420px at 85% -10%, rgba(255,255,255,0.14), rgba(0,0,0,0) 70%)',
      color: '#fafafa',
      fontFamily: 'Inter',
    },
    [
      h('div', { display: 'flex', alignItems: 'center', gap: 18 }, [
        h('img', { width: 56, height: 56 }, undefined, { src: logo, width: 56, height: 56 }),
        h('div', { fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }, 'vid2context'),
        h(
          'div',
          { marginLeft: 12, padding: '6px 16px', border: '1px solid #3d3d3d', borderRadius: 999, fontSize: 22, color: '#a3a3a3' },
          opts.kicker,
        ),
      ]),
      // Satori wraps text only inside a box of definite width, so each block spans the card.
      h('div', { display: 'flex', flexDirection: 'column', gap: 22, width: '100%' }, [
        h(
          'div',
          {
            display: 'flex',
            width: '100%',
            fontSize: title.length > 36 ? 60 : 72,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -2,
          },
          title,
        ),
        description
          ? h('div', { display: 'flex', width: '100%', fontSize: 28, lineHeight: 1.4, color: '#a3a3a3' }, description)
          : h('div', {}, ''),
      ]),
      h(
        'div',
        { display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', fontSize: 24, color: '#a3a3a3' },
        [
          h('div', {}, opts.footer ?? 'vid2context.com'),
          h('div', { width: 220, height: 6, borderRadius: 999, backgroundImage: 'linear-gradient(90deg, #ffffff, #d4d4d4)' }, ''),
        ],
      ),
    ],
  );
  const svg = await satori(tree as never, { width, height, fonts });
  return new Uint8Array(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
}

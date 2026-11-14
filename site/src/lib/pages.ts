/**
 * Every HTML page on the site with what the sitemap, the Markdown twins, the
 * OG images and llms.txt need. The landing page's twin is rendered here from
 * the same data the page uses (src/data/landing.ts).
 */
import { chatgpt, clients, npmPublished, primaryCommand } from '../data/agents.ts';
import { chain, faq, hero, modelsCopy, sourcesCopy, steps, useCases } from '../data/landing.ts';
import { data, KIND_LABEL, lastModOf, REPO_URL, rungsByTier, SITE_URL, TIER_INFO, TIERS } from '../data/site.ts';
import { docPages, twinOf } from './docs.ts';

export interface SitePage {
  url: string;
  twinUrl: string;
  title: string;
  description: string;
  lastmod: string;
  twin: string;
  /** Short label for the OG image. */
  kicker: string;
}

export const HOME = {
  title: 'vid2context: turn any video into context for AI agents',
  description:
    'Paste a video link, get the transcript, chapters and metadata as Markdown, a .zip, or straight into Claude, Cursor or ChatGPT over MCP. Free and open source.',
};

const fence = (lang: string, text: string) => `\`\`\`${lang}\n${text.replace(/\n$/, '')}\n\`\`\``;

function homeTwin(): string {
  const tiers = rungsByTier();
  const out: string[] = [];
  out.push(`# ${hero.title}`, hero.sub, `Open a video in the app: ${SITE_URL}/app/?url=<encoded link>. Examples:`);
  out.push(hero.chips.map((c) => `- [${c.label}](${SITE_URL}/app/?url=${encodeURIComponent(c.url)})`).join('\n'));
  out.push(hero.badges.map((b) => `- ${b}`).join('\n'));

  const ctx = data.demo.files.find((f) => f.path === 'context.md');
  out.push(
    '## A real result',
    `The bundle vid2context produces for "${data.demo.title}" (${data.demo.url}), rendered from a recorded run. Files in ${data.demo.zipName}: ${data.demo.files.map((f) => `\`${f.path}\``).join(', ')}. This is \`context.md\`:`,
  );
  if (ctx) out.push(fence('markdown', ctx.text));
  out.push(`Try the live API: \`curl "${SITE_URL}/api/v1/transcript?url=${data.demo.url}&timestamps=1"\`. YouTube often blocks cloud servers, so run it locally when that fails.`);

  out.push('## How it works', steps.map((s) => `${Number(s.n)}. **${s.title}.** ${s.body}`).join('\n'));
  out.push('The transcript chain, tried in order:', chain.map((c, n) => `${n + 1}. **${c.title}:** ${c.body}`).join('\n'));

  out.push(`## ${sourcesCopy.title}`, sourcesCopy.sub);
  out.push(data.sources.map((s) => `- ${s.name}: ${s.catchAll ? 'with the yt-dlp provider' : `${s.providerName} provider`}`).join('\n'));

  out.push(`## ${modelsCopy.title}`, modelsCopy.sub);
  for (const tier of TIERS) {
    out.push(`### ${TIER_INFO[tier].label} (${tiers[tier].length} rungs)`, TIER_INFO[tier].meaning);
    out.push(
      tiers[tier]
        .map((r) => `- ${KIND_LABEL[r.kind] ?? r.kind}: ${r.service} \`${r.model || r.requires[0] || 'any model'}\`${r.requires.length ? ` (needs ${r.requires.join(', ')})` : ''}`)
        .join('\n'),
    );
  }
  out.push(`Details: ${SITE_URL}/docs/providers.md`);

  out.push(
    '## Agents and MCP',
    npmPublished
      ? `Add the MCP server (${data.npm.mcpPackage} on npm) and ask about any video. No key needed.`
      : 'Add the MCP server and ask about any video. No key needed. Until the npm package is published, run it from a clone: `git clone https://github.com/nirholas/vid2context.git && cd vid2context && npm install`.',
  );
  for (const c of clients) {
    const cmd = primaryCommand(c);
    out.push(`### ${c.name}`, `${c.short} Guide: ${SITE_URL}${twinOf(`/docs/clients/${c.slug}/`)}`);
    if (cmd) out.push(fence(cmd.lang, cmd.text));
  }
  const chatgptCmd = chatgpt.steps.find((s) => s.code)?.code;
  out.push(`### ${chatgpt.name}`, `${chatgpt.short} ChatGPT connects only to remote MCP servers over HTTPS.`);
  if (chatgptCmd) out.push(fence(chatgptCmd.lang, chatgptCmd.text));
  if (data.mcpTools) out.push(`Tools (${data.mcpTools.length}):`, data.mcpTools.map((t) => `- \`${t.name}\`: ${t.description}`).join('\n'));

  out.push('## Use cases');
  for (const u of useCases) {
    out.push(`### ${u.title}`, u.body);
    if (u.example) out.push(u.example.caption, fence(u.example.lang, u.example.text));
  }

  if (data.deployTargets.length) {
    out.push('## Self-host');
    for (const t of data.deployTargets) {
      out.push(`- **${t.name}:** ${t.summary}${t.command ? ` \`${t.command}\`` : ''}${t.doc ? ` Guide: ${SITE_URL}${twinOf(`/docs/${t.doc.replace(/^docs\//, '').replace(/\.md$/, '')}/`)}` : ''}`);
    }
  }

  out.push('## FAQ', faq.map((f) => `### ${f.q}\n\n${f.a}`).join('\n\n'));
  out.push('## Links', [`- Docs: ${SITE_URL}/docs.md`, `- Source: ${REPO_URL}`, `- llms.txt: ${SITE_URL}/llms.txt`, `- License: ${data.meta.license}`].join('\n'));
  return `${out.join('\n\n')}\n`;
}

let cached: SitePage[] | undefined;

export function sitePages(): SitePage[] {
  if (cached) return cached;
  const home: SitePage = {
    url: '/',
    twinUrl: '/index.md',
    title: HOME.title,
    description: HOME.description,
    lastmod: lastModOf(['site/src', 'tests/fixtures/contexts', 'packages/discovery/src']),
    twin: homeTwin(),
    kicker: 'Video to context',
  };
  cached = [
    home,
    ...docPages().map((d) => ({
      url: d.url,
      twinUrl: d.twinUrl,
      title: d.title,
      description: d.description,
      lastmod: d.lastmod,
      twin: d.twin,
      kicker: d.section === 'start' && d.slug === '' ? 'Documentation' : 'Docs',
    })),
  ];
  return cached;
}

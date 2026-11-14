/**
 * `{{name}}` tokens in the site's own Markdown pages, so commands and outputs
 * are never retyped: install commands come from @vid2context/discovery, real
 * outputs are rendered by @vid2context/core from recorded fixtures, counts
 * come from the registry. An unknown token fails the build.
 */
import { clients, chatgpt, type InstallStep, npmPublished } from '../data/agents.ts';
import { allRungs, data, rungsByTier, serviceCount } from '../data/site.ts';

function stepsMarkdown(steps: InstallStep[]): string {
  return steps
    .map((s, n) => {
      const parts = [`${n + 1}. ${s.text}`];
      if (s.buttons?.length) parts.push(s.buttons.map((b) => `   [${b.label}](${b.href} "button")`).join('\n'));
      if (s.code) parts.push(`   \`\`\`${s.code.lang}\n${s.code.text.replace(/^/gm, '   ')}\n   \`\`\``);
      return parts.join('\n\n');
    })
    .join('\n\n');
}

export function clientSteps(slug: string): string {
  const c = clients.find((x) => x.slug === slug);
  if (!c) throw new Error(`Unknown client "${slug}" in a {{client:...}} token.`);
  return stepsMarkdown(c.steps);
}

function values(): Record<string, string> {
  const tiers = rungsByTier();
  const v: Record<string, string> = {
    'stats.rungs': String(allRungs().length),
    'stats.services': String(serviceCount()),
    'stats.local': String(tiers.local.length),
    'stats.free': String(tiers.free.length),
    'stats.keyless': String(tiers.keyless.length),
    'stats.paid': String(tiers.paid.length),
    'stats.sttKeyless': String(tiers.keyless.filter((r) => r.kind === 'stt').length),
    'stats.formats': String(data.formatters.length),
    'formats.list': data.formatters.map((f) => `- \`${f.id}\` (.${f.extension}): ${f.description}`).join('\n'),
    'formats.ids': data.formatters.map((f) => `\`${f.id}\``).join(', '),
    'npm.package': data.npm.mcpPackage,
    'chatgpt.steps': stepsMarkdown(chatgpt.steps),
    'install.envVars': data.install.envVarsMarkdown,
    'sttKeyless.list': tiers.keyless
      .filter((r) => r.kind === 'stt')
      .map((r) => `\`${r.service}\` \`${r.model}\``)
      .join(', '),
    'sttLocal.list': tiers.local
      .filter((r) => r.kind === 'stt')
      .map((r) => `- \`${r.id}\`${r.requires.length ? `: set ${r.requires.map((x) => `\`${x}\``).join(' and ')}` : ''}`)
      .join('\n'),
    'sttFree.list': tiers.free
      .filter((r) => r.kind === 'stt')
      .map((r) => `- \`${r.id}\`: set ${r.requires.map((x) => `\`${x}\``).join(' and ')}`)
      .join('\n'),
    'mcp.installMode': npmPublished
      ? `the published npm package \`${data.npm.mcpPackage}\``
      : 'a clone of the repo, because the npm package is not published yet',
  };
  // From a clone; -s keeps npm's banner out of redirected output.
  v.cli = 'npm run -s cli --';
  v['demo.contextMd'] = data.demo.files.find((f) => f.path === 'context.md')?.text ?? '';
  v['demo.fileList'] = data.demo.files.map((f) => `\`${f.path}\``).join(', ');
  v['mcp.toolCount'] = String(data.mcpTools?.length ?? 0);
  v['mcp.tools'] = (data.mcpTools ?? []).map((t) => `- \`${t.name}\`: ${t.description}`).join('\n');
  if (data.playlist) {
    v['playlist.url'] = data.playlist.url;
    v['playlist.title'] = data.playlist.title ?? 'the playlist';
    v['playlist.count'] = String(data.playlist.items.length);
    v['playlist.list'] = data.playlist.items.map((item) => item.url).join('\n');
  }
  for (const [k, val] of Object.entries(data.install)) v[`install.${k}`] = val;
  for (const [k, val] of Object.entries(data.demo)) if (typeof val === 'string' || typeof val === 'number') v[`demo.${k}`] = String(val);
  for (const [k, val] of Object.entries(data.gwagon)) if (typeof val === 'string' || typeof val === 'number') v[`gwagon.${k}`] = String(val);
  for (const [k, val] of Object.entries(data.whisper)) if (typeof val === 'string' || typeof val === 'number') v[`whisper.${k}`] = String(val);
  return v;
}

const cache = values();

/** Expand every `{{token}}`. Multi-line values keep the indentation of the line they sit on. */
export function expandTokens(source: string, where: string): string {
  return source
    .split('\n')
    .map((line) => {
      const indent = line.match(/^[ \t]*/)?.[0] ?? '';
      return line.replace(/\{\{([a-zA-Z0-9.:-]+)\}\}/g, (_m, name: string) => {
        const value = name.startsWith('client:') ? clientSteps(name.slice('client:'.length)) : cache[name];
        if (value === undefined) throw new Error(`Unknown token {{${name}}} in ${where}.`);
        return value.replace(/\n$/, '').replace(/\n/g, `\n${indent}`);
      });
    })
    .join('\n');
}

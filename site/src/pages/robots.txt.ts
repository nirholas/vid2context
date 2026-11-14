/** Allow everything, name the AI crawlers explicitly, keep JSON API responses out of indexes. */
import type { APIRoute } from 'astro';
import { SITE_URL } from '../data/site.ts';

const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot',
  'Applebot-Extended',
];

export const GET: APIRoute = () => {
  const groups = [
    ['User-agent: *', 'Allow: /', 'Disallow: /api/'],
    ...AI_CRAWLERS.map((bot) => [`User-agent: ${bot}`, 'Allow: /', 'Disallow: /api/']),
  ];
  const body = `${groups.map((g) => g.join('\n')).join('\n\n')}\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

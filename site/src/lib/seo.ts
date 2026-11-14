/**
 * JSON-LD for every page: one @graph with WebSite, SoftwareApplication and
 * SoftwareSourceCode, plus FAQPage on the landing page and BreadcrumbList on
 * docs pages. Facts come from @vid2context/discovery through the generated data.
 */
import type { Faq } from '../data/landing.ts';
import { data, SITE_URL } from '../data/site.ts';

const LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';

type Node = Record<string, unknown>;

export function baseGraph(): Node[] {
  const m = data.meta;
  return [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: `${SITE_URL}/`,
      name: m.title,
      description: m.shortDescription,
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#app`,
      name: m.title,
      url: `${SITE_URL}/`,
      description: m.description,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux, Windows',
      softwareVersion: m.softwareVersion,
      license: LICENSE_URL,
      // The npm page once the package is published; until then the source is the download.
      downloadUrl: data.npm.published ? data.npm.url : m.repoUrl,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      keywords: m.keywords.join(', '),
      sameAs: [m.repoUrl],
    },
    {
      '@type': 'SoftwareSourceCode',
      '@id': `${SITE_URL}/#source`,
      name: m.title,
      codeRepository: m.repoUrl,
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js',
      license: LICENSE_URL,
      targetProduct: { '@id': `${SITE_URL}/#app` },
    },
  ];
}

export function faqNode(items: Faq[]): Node {
  return {
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/#faq`,
    mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
}

export function breadcrumbNode(trail: { name: string; url: string }[]): Node {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, n) => ({ '@type': 'ListItem', position: n + 1, name: t.name, item: `${SITE_URL}${t.url}` })),
  };
}

/** Serialized for a <script type="application/ld+json">; `<` is escaped so no text can close the tag. */
export function jsonLd(nodes: Node[]): string {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replace(/</g, '\\u003c');
}

/** The OG image path for a page URL: /og/index.png, /og/docs.png, /og/docs/architecture.png. */
export function ogImageFor(url: string): string {
  const key = url.replace(/^\/|\/$/g, '') || 'index';
  return `/og/${key}.png`;
}

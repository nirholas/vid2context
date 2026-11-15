---
title: Embed in WordPress, Notion, React and more
label: Platforms and self-hosting
description: Step-by-step embedding of the vid2context widget in WordPress, Notion, Ghost, Webflow, Squarespace, React, Next.js, Vue, Svelte, Docusaurus and Markdown, plus serving the widget from your own deployment.
order: 3
---

The widget is a page, so any tool that can show an iframe can show it. Get the address or the snippet from the [builder](/docs/embed/) first.

## WordPress

In the block editor, add a **Custom HTML** block and paste the iframe snippet. The classic editor takes the same snippet in its **Text** tab. Iframes are allowed for administrators and editors by default; if your role strips them, ask an administrator to add the block.

## Notion

Type `/embed`, choose **Embed**, and paste the widget address (not the HTML), for example `https://vid2context.com/embed/?url=https://www.youtube.com/watch?v=jNQXAC9IVRw`. Drag the bottom edge of the block to set its height.

## Ghost, Webflow, Squarespace, Wix

Each has an HTML or code block: Ghost's **HTML** card, Webflow's **Embed** element, Squarespace's **Code** block and Wix's **Embed HTML** (choose "Code"). Paste the iframe snippet, or the web component snippet if the block allows scripts.

## React and Next.js

Use the **React** snippet from the builder, a plain `<iframe>`. For events and auto height, load the script once and render the element:

```tsx
import { useEffect, useRef } from 'react';

export function VideoTranscript({ url }: { url: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!document.querySelector('script[data-vid2context]')) {
      const s = document.createElement('script');
      s.src = 'https://vid2context.com/embed.js';
      s.async = true;
      s.dataset.vid2context = '';
      document.head.append(s);
    }
    const el = ref.current;
    const onSegment = (e: Event) => console.log((e as CustomEvent).detail.text);
    el?.addEventListener('vid2context:segment', onSegment);
    return () => el?.removeEventListener('vid2context:segment', onSegment);
  }, []);
  return <vid2context-embed ref={ref} url={url} max-height="520" />;
}
```

In TypeScript, declare the element once so JSX accepts it:

```ts
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'vid2context-embed': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & Record<string, string>;
    }
  }
}
```

In the Next.js App Router, put the component in a file that starts with `'use client'`.

## Vue and Svelte

Both pass unknown elements through. In Vue, tell the compiler the tag is a custom element (`compilerOptions.isCustomElement: (tag) => tag === 'vid2context-embed'`) and listen with `@vid2context:segment`. In Svelte, write `<vid2context-embed url={url} on:vid2context:segment={handler} />`. Load `/embed.js` once in your page head.

## Docusaurus, VitePress, Astro, MDX

MDX and Astro accept the iframe snippet as is (in MDX, write `style={{ border: 0 }}` instead of a style string). VitePress and other Markdown engines that allow HTML take the iframe or the web component directly.

## GitHub READMEs and other Markdown without HTML

GitHub strips iframes and scripts. Use the **Link** snippet: the widget address opens as a full page with the same view.

## Serve the widget from your own deployment

Every vid2context deployment that serves this site also serves `/embed/` and `/embed.js` (see [Deploy](/docs/deploy/cloudflare/) for the Cloudflare Worker). Load the script from your own origin and the element embeds your server's widget, which calls your server's API:

```html
<script src="https://videos.example.org/embed.js" async></script>
<vid2context-embed url="https://www.youtube.com/watch?v=jNQXAC9IVRw"></vid2context-embed>
```

To keep the widget on vid2context.com but read from your own API, set `api`:

```text
https://vid2context.com/embed/?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&api=https://videos.example.org
```

Your server must then allow the widget's origin: start it with `VID2CONTEXT_CORS_ORIGINS=https://vid2context.com`. If your server requires an API key, embed it from your own deployment instead, so the key never appears in a page.

## Content Security Policy

If your site sends a Content Security Policy, allow the widget's origin in `frame-src` (and `script-src` for the web component):

```text
Content-Security-Policy: frame-src https://vid2context.com; script-src 'self' https://vid2context.com
```

With `player=1`, the widget itself loads `https://www.youtube-nocookie.com`; that is the widget's own request, so your policy does not need it.

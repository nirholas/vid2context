import { chromium } from '@playwright/test';
const exe = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome`;
const out = process.argv[2];
const pages = (process.argv[3] ?? '/').split(',');
const b = await chromium.launch({ executablePath: exe });
for (const [w, h, tag] of [[1440, 900, 'desk'], [375, 800, 'mob']]) {
  for (const theme of (process.env.THEMES ?? 'dark').split(',')) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await ctx.addInitScript((t) => localStorage.setItem('v2c.theme', t), theme);
    const p = await ctx.newPage();
    for (const path of pages) {
      await p.goto(`http://127.0.0.1:24817${path}`, { waitUntil: 'networkidle' });
      const name = `${out}/${tag}-${theme}${path.replace(/\//g, '_')}.png`;
      await p.screenshot({ path: name, fullPage: process.env.FULL !== '0' });
      console.log(name);
    }
    await ctx.close();
  }
}
await b.close();

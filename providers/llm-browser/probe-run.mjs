import { chromium } from 'playwright';
import { createServer } from 'vite';

const [demo, rung, model, timeoutMs] = process.argv.slice(2);
const port = 20000 + Math.floor(Math.random() * 10000);
const server = await createServer({ configFile: `${demo}/vite.config.mjs`, server: { port, host: '127.0.0.1' } });
await server.listen();
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] });
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error', m.text().slice(0, 300));
});
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => document.getElementById('support').dataset.state === 'done');
await page.selectOption('#rung', rung);
if (model) await page.fill('#model', model);
await page.click('#run');
const t = Date.now();
try {
  await page.waitForFunction(() => ['done', 'error'].includes(document.getElementById('status').dataset.state), null, {
    timeout: Number(timeoutMs),
  });
} catch (e) {
  console.log('timeout; status:', await page.textContent('#status'));
}
console.log('status:', await page.textContent('#status'), Date.now() - t + 'ms');
console.log('answer:', await page.textContent('#answer'));
console.log('result:', await page.getAttribute('#status', 'data-result'));
console.log('log:', (await page.textContent('#log')).slice(-800));
await browser.close();
await server.close();

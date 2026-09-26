// End-to-end test: loads the real extension into Chromium and drives it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../../extension');
const MASTER = 'correct horse battery staple';
let server, base, ctx, extId, tmp;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(here, 'site', new URL(req.url, 'http://x').pathname);
    if (!file.startsWith(path.join(here, 'site')) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-'));
  ctx = await chromium.launchPersistentContext(tmp, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
  // Close the welcome tab opened on install.
  await new Promise((r) => setTimeout(r, 500));
  for (const p of ctx.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
});

after(async () => {
  await ctx?.close();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const extUrl = (p) => `chrome-extension://${extId}/src/${p}`;

async function dropdownFrame(page) {
  await page.waitForFunction(() => document.querySelectorAll('body > div').length > 0, null, { timeout: 5000 });
  for (let i = 0; i < 50; i++) {
    const f = page.frames().find((fr) => fr.url().includes('/src/ui/dropdown.html'));
    if (f) {
      await f.waitForSelector('button.item', { timeout: 5000 });
      return f;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('dropdown not shown');
}

test('create vault and import a Brave CSV', async () => {
  const page = await ctx.newPage();
  await page.goto(extUrl('manager/manager.html'));
  await page.fill('input[placeholder="Master password"]', MASTER);
  await page.fill('input[placeholder="Confirm master password"]', MASTER);
  await page.click('button:has-text("Create vault")');
  await page.waitForSelector('h1:has-text("Import passwords")');

  const csvPath = path.join(tmp, 'Brave Passwords.csv');
  fs.writeFileSync(csvPath, `name,url,username,password,note\nlocalhost,${base}/login.html,alice@example.com,s3cret-alice,\nlocalhost,${base}/,bob@example.com,s3cret-bob,\nother,https://other.example/,carol,pw,\n`);
  await page.setInputFiles('input[type=file]', csvPath);
  await page.click('main button.primary:has-text("Import")');
  await page.waitForSelector('.result');
  assert.match(await page.textContent('.result'), /Imported 3 new passwords/);
  await page.close();
});

test('inline menu fills the chosen login and never touches hidden fields', async () => {
  const page = await ctx.newPage();
  await page.goto(base + '/login.html');
  await page.click('#user');
  const frame = await dropdownFrame(page);
  const items = await frame.$$eval('button.item', (els) => els.map((e) => e.textContent));
  assert.equal(items.length, 2);
  assert.ok(items.some((t) => t.includes('alice@example.com')));
  assert.ok(!items.some((t) => t.includes('carol')), 'other sites must not be offered');

  // The page itself cannot read the menu (it is cross-origin).
  const leaked = await page.evaluate(() => {
    try {
      return document.querySelector('iframe')?.contentDocument?.body?.innerText ?? 'no access';
    } catch {
      return 'no access';
    }
  });
  assert.equal(leaked, 'no access');

  await frame.click('button.item:has-text("bob@example.com")');
  await page.waitForFunction(() => document.querySelector('#pass').value !== '');
  assert.equal(await page.inputValue('#user'), 'bob@example.com');
  assert.equal(await page.inputValue('#pass'), 's3cret-bob');
  assert.equal(await page.$eval('#trapPass', (e) => e.value), '', 'hidden field must stay empty');
  await page.close();
});

test('offers to save a new login after sign-in', async () => {
  const page = await ctx.newPage();
  await page.goto(base + '/login.html');
  await page.fill('#user', 'dave@example.com');
  await page.fill('#pass', 'brand-new-pass');
  await page.keyboard.press('Escape');
  await page.click('button[type=submit]');
  await page.waitForURL(/welcome/);
  let bar;
  for (let i = 0; i < 50 && !bar; i++) {
    bar = page.frames().find((fr) => fr.url().includes('/src/ui/savebar.html'));
    if (!bar) await page.waitForTimeout(100);
  }
  assert.ok(bar, 'save prompt shown');
  await bar.waitForSelector('button.primary:has-text("Save")');
  assert.equal(await bar.inputValue('input[aria-label=Username]'), 'dave@example.com');
  await bar.click('button.primary:has-text("Save")');

  const mgr = await ctx.newPage();
  await mgr.goto(extUrl('manager/manager.html'));
  await mgr.waitForSelector('.tr');
  assert.match(await mgr.textContent('.table'), /dave@example\.com/);
  await mgr.close();
  await page.close();
});

test('suggests a strong password on sign-up forms', async () => {
  const page = await ctx.newPage();
  await page.goto(base + '/signup.html');
  await page.click('#new1');
  const frame = await dropdownFrame(page);
  await frame.click('button.item:has-text("Use a strong password")');
  await page.waitForFunction(() => document.querySelector('#new1').value.length >= 20);
  const [a, b] = await Promise.all([page.inputValue('#new1'), page.inputValue('#new2')]);
  assert.equal(a, b);
  await page.close();
});

test('when locked, the menu only offers to unlock', async () => {
  const popup = await ctx.newPage();
  await popup.goto(extUrl('popup/popup.html'));
  await popup.click('button:has-text("Lock")');
  await popup.waitForSelector('h2:has-text("Vault locked")');

  const page = await ctx.newPage();
  await page.goto(base + '/login.html');
  await page.click('#pass');
  const frame = await dropdownFrame(page);
  const text = await frame.textContent('body');
  assert.match(text, /Unlock Helium Vault/);
  assert.ok(!text.includes('@example.com'));

  // Unlock via popup, and the open menu fills in.
  await popup.fill('input[type=password]', MASTER);
  await popup.click('button:has-text("Unlock")');
  await frame.waitForSelector('button.item:has-text("alice@example.com")', { timeout: 5000 });
  await page.close();
  await popup.close();
});

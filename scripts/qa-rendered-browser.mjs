/** Real built React UI + real local server. No Socket.IO/controller mocks.
 * Chromium mobile viewport is NOT physical iPhone or Safari acceptance.
 */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const base = process.env.QA_BASE_URL;
assert.ok(base, 'QA_BASE_URL is required; no live default');
const origin = new URL(base);
assert.equal(origin.protocol, 'http:');
assert.equal(origin.hostname, '127.0.0.1', 'Owned loopback application only');
assert.equal(origin.username + origin.password, '');
const browser = await chromium.launch(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {});
const errors = [];
const joins = [];
const sent = [];
const checks = [];
try {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const desktop = await browser.newContext();
  // Fail closed on redirects/subresources outside the exact owned origin.
  for (const context of [mobile, desktop]) {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin.origin ? route.continue() : route.abort();
    });
  }
  const page = await mobile.newPage();
  const peer = await desktop.newPage();
  for (const p of [page, peer]) p.on('pageerror', error => errors.push(error.message));
  const observeWire = payload => {
    const wire = String(payload);
    if (!wire.startsWith('42')) return;
    const offset = wire.indexOf('[');
    if (offset < 0) return;
    const [event, data] = JSON.parse(wire.slice(offset));
    if (event === 'join-room') joins.push(data.roomId);
    if (event === 'send-message') sent.push({ message: data.message, key: data.clientMessageId });
  };
  page.on('websocket', ws => ws.on('framesent', ({ payload }) => observeWire(payload)));
  // Initial Socket.IO joins may precede WebSocket upgrade and use HTTP polling.
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/socket.io/' && request.method() === 'POST') {
      for (const packet of (request.postData() || '').split('\u001e')) observeWire(packet);
    }
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Create Room', exact: true }).click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  const roomUrl = page.url();
  assert.match(new URL(roomUrl).searchParams.get('id'), /^[a-z]{3,5}\d{3}$/);
  const join = async (p, name) => {
    await p.getByLabel('Username', { exact: true }).fill(name);
    await p.getByLabel('Room password (if any)', { exact: true }).fill('owned-browser-fixture');
    await p.getByRole('button', { name: 'Join Chat', exact: true }).click();
    await expect(p.getByRole('status')).toContainText('online', { timeout: 15000 });
  };
  await join(page, 'BrowserMobile');
  await peer.goto(roomUrl);
  await join(peer, 'BrowserPeer');
  checks.push('rendered create/claim/password join in two isolated browser contexts');
  const send = async (p, message) => {
    await p.getByLabel('Message', { exact: true }).fill(message);
    await p.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(p.getByLabel('Message', { exact: true })).toHaveValue('');
    await expect(p.getByText(message, { exact: true })).toHaveCount(1);
  };
  await send(page, 'browser-before-offline');
  await expect(peer.getByText('browser-before-offline', { exact: true })).toHaveCount(1);
  await page.getByLabel('Message', { exact: true }).fill('browser-draft-after-reconnect');
  await mobile.setOffline(true);
  await expect(page.getByRole('status')).toContainText('Reconnecting', { timeout: 60000 });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Attach file', exact: true })).toBeDisabled();
  await send(peer, 'browser-missed-while-offline');
  await mobile.setOffline(false);
  await expect(page.getByRole('status')).toContainText('online', { timeout: 20000 });
  await expect(page.getByText('browser-missed-while-offline', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('browser-draft-after-reconnect');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(peer.getByText('browser-draft-after-reconnect', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  checks.push('offline disables writes; reconnect restores missed history and preserves unsent draft');
  const bytes = Buffer.from('rendered browser exact file bytes\n');
  await page.locator('input[type=file]').setInputFiles({ name: 'browser-proof.txt', mimeType: 'text/plain', buffer: bytes });
  await expect(peer.getByText('browser-proof.txt', { exact: true })).toHaveCount(1);
  const href = await peer.getByTitle('Download', { exact: true }).getAttribute('href');
  const downloadUrl = new URL(href, base);
  assert.equal(downloadUrl.origin, origin.origin);
  const download = await desktop.request.get(downloadUrl.href, { maxRedirects: 0 });
  assert.equal(download.status(), 200);
  assert.deepEqual(await download.body(), bytes);
  checks.push('real multipart file input, peer rendering and exact downloaded bytes');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'browser-pixel.png', mimeType: 'image/png', buffer: png });
  const image = peer.getByAltText('browser-pixel.png', { exact: true });
  await expect(image).toHaveCount(1);
  await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await image.click();
  await expect(peer.locator('img[alt=""]')).toBeVisible();
  const imageUrl = new URL(await image.getAttribute('src'), base);
  assert.equal(imageUrl.origin, origin.origin);
  const imageDownload = await desktop.request.get(imageUrl.href, { maxRedirects: 0 });
  assert.equal(imageDownload.status(), 200);
  assert.deepEqual(await imageDownload.body(), png);
  checks.push('real image multipart, decoded peer image/lightbox and exact bytes');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('browser-before-offline', { exact: true })).toHaveCount(1);
  await expect(page.getByText('browser-missed-while-offline', { exact: true })).toHaveCount(1);
  await expect.poll(() => sent.length).toBe(2);
  assert.equal(new Set(sent.map(x => x.key)).size, 2);
  assert.ok(sent.every(x => typeof x.key === 'string' && x.key.length > 0));
  assert.ok(joins.length >= 2, 'Observed actual initial join and reconnect, not a mocked state');
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  checks.push('observed keyed text frames, actual rejoin and duplicate-free UI snapshots');
  console.log(JSON.stringify({ result: 'PASS', checks, browser: browser.version(), scope: 'Chromium mobile viewport + desktop; legacy join/upload; NOT durable resume, physical device or storage capacity proof' }));
} finally {
  await browser.close();
}

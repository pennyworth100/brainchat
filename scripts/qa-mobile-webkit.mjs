// Optional UI regression: QA_PLAYWRIGHT_MODULE=/absolute/path/playwright/index.mjs node scripts/qa-mobile-webkit.mjs
import assert from 'node:assert/strict';
const { webkit, devices } = await import(process.env.QA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:3302';
assert.equal(new URL(base).hostname, '127.0.0.1', 'Use an isolated local DB, never production');
const response = await fetch(`${base}/api/rooms`, { method: 'POST' });
assert.equal(response.status, 201);
const { roomId, creationToken } = await response.json();
const browser = await webkit.launch({ headless: true });
const phoneContext = await browser.newContext({ ...devices['iPhone 13'] });
const desktopContext = await browser.newContext();
const phone = await phoneContext.newPage();
const desktop = await desktopContext.newPage();
const errors = [];
phone.on('pageerror', (err) => errors.push(err.message));
desktop.on('pageerror', (err) => errors.push(err.message));
const ready = (page, text) => page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 30000 });
const join = async (page, name) => {
  await page.goto(`${base}/room?id=${roomId}`);
  await page.getByLabel('Username', { exact: true }).fill(name);
  await page.getByLabel('Room password (if any)', { exact: true }).fill('local-ui-qa');
  await page.getByRole('button', { name: 'Join Chat', exact: true }).click();
  await ready(page, /online/);
};
const send = async (page, text) => {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(text, { exact: true }).waitFor();
};
try {
  await phoneContext.addInitScript(({ roomId, creationToken }) => sessionStorage.setItem(`dimle:creation-token:${roomId}`, creationToken), { roomId, creationToken });
  await join(phone, 'Mobile WebKit');
  await join(desktop, 'Desktop');
  await ready(phone, '2 online');
  await send(phone, 'before mobile interruption');
  await desktop.getByText('before mobile interruption', { exact: true }).waitFor();
  await phoneContext.setOffline(true);
  await phone.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  // Never continue to show the stale participant count while checking the link.
  await ready(phone, /Syncing|Reconnecting/);
  assert.equal(await phone.getByText('2 online', { exact: true }).count(), 0);
  await send(desktop, 'desktop while mobile absent');
  await phoneContext.setOffline(false);
  await phone.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await ready(phone, '2 online');
  await phone.getByText('desktop while mobile absent', { exact: true }).waitFor();
  assert.equal(await phone.getByText('before mobile interruption', { exact: true }).count(), 1);
  assert.equal(await phone.getByText('desktop while mobile absent', { exact: true }).count(), 1);
  await send(phone, 'mobile after rejoin');
  await desktop.getByText('mobile after rejoin', { exact: true }).waitFor();
  console.log('PASS mobile WebKit offline/resume, truthful connection status, history dedup, bidirectional messaging');

  const pdf = Buffer.from('%PDF-1.7\nSynthetic UI regression\n%%EOF');
  await phone.locator('input[type=file]').setInputFiles({ name: 'mobile-qa.pdf', mimeType: 'application/pdf', buffer: pdf });
  await phone.getByText('mobile-qa.pdf', { exact: true }).waitFor();
  await desktop.getByText('mobile-qa.pdf', { exact: true }).waitFor();
  assert.equal(await phone.getByText('mobile-qa.pdf', { exact: true }).count(), 1);
  const download = await Promise.all([phone.waitForEvent('download'), phone.getByTitle('Download', { exact: true }).click()]);
  const path = await download[0].path();
  assert.deepEqual(await (await import('node:fs/promises')).readFile(path), pdf);
  console.log('PASS mobile WebKit PDF upload, desktop arrival, one attachment, download byte match');

  await phoneContext.route('**/api/upload', (route) => route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'File is too large (maximum 100 MB).' }) }));
  await phone.locator('input[type=file]').setInputFiles({ name: 'rejected.pdf', mimeType: 'application/pdf', buffer: pdf });
  await phone.getByText(/Upload failed: rejected.pdf.*100 MB/).waitFor();
  await send(desktop, 'desktop after rejected PDF');
  await phone.getByText('desktop after rejected PDF', { exact: true }).waitFor();
  await send(phone, 'phone after rejected PDF');
  await desktop.getByText('phone after rejected PDF', { exact: true }).waitFor();
  console.log('PASS explicit PDF error leaves both directions usable');
  await phone.evaluate(() => {
    document.querySelector('.chat-timeline').scrollTop = 0;
    window.dispatchEvent(new Event('pageshow'));
  });
  await ready(phone, '2 online');
  assert.equal(await phone.locator('.chat-timeline').evaluate((el) => el.scrollTop), 0, 'unchanged sync must not scroll away from history');
  await phone.locator('.chat-timeline').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await phone.screenshot({ path: '/private/tmp/dimle302-mobile-webkit.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', engine: 'WebKit, iPhone 13 emulation (not a physical iPhone)', roomId, pageErrors: errors.length }));
} finally {
  await browser.close();
}

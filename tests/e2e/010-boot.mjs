/** Boot: page loads, WebGL2 acquired, main menu visible in zh, no console errors; EN toggle not yet (L8). */
export default async function ({ page, url, shot, expect, ready }) {
  await page.goto(url + 'index.html?test=1&seed=1', { waitUntil: 'load' });
  await ready();
  expect(await page.locator('#gl').count() === 1, 'canvas present');
  const webgl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  expect(webgl2, 'WebGL2 available');
  await page.waitForSelector('[data-testid="screen-main"]', { timeout: 10000 });
  const play = await page.locator('[data-testid="btn-play"]').textContent();
  expect(play && play.includes('开始'), `play button is zh: ${play}`);
  await shot('main-menu');
}

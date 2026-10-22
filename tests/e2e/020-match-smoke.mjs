/** Match smoke: start a defusal match via test hooks, step 600 ticks synchronously, assert phases advance and no errors. */
export default async function ({ page, url, shot, expect, ready, dbg }) {
  await page.goto(url + 'index.html?test=1&seed=7', { waitUntil: 'load' });
  await ready();
  await dbg('startMatch', { mode: 'defusal', seed: 7, teamSize: 5 });
  await page.waitForSelector('[data-testid="hud"]', { timeout: 10000 });
  await dbg('stepTicks', 10);
  expect((await dbg('phase')) === 'FREEZE', 'round starts in FREEZE');
  await dbg('stepTicks', 320);
  expect((await dbg('phase')) === 'LIVE', 'FREEZE → LIVE after 5 s');
  const s = await dbg('state');
  expect(s.players.length === 10, `10 players, got ${s.players.length}`);
  expect(s.players.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)), 'positions finite');
  const h1 = await dbg('hash');
  await dbg('stepTicks', 600);
  const h2 = await dbg('hash');
  expect(h1 !== h2, 'state advances');
  await dbg('resume');
  await page.waitForTimeout(500);
  await shot('in-match');
}

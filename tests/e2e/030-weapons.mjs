/** Weapons: training range, give an AK, hold FIRE 1 s → ≈ 10 shots; RELOAD → mag restored; no page errors. */
export default async function ({ page, url, shot, expect, ready, dbg }) {
  await page.goto(url + 'index.html?test=1&seed=3', { waitUntil: 'load' });
  await ready();
  await dbg('startMatch', { mode: 'training', seed: 3 });
  await page.waitForSelector('[data-testid="hud"]', { timeout: 10000 });
  await dbg('stepTicks', 2); // training's first tick resets the loadout (WARMUP → LIVE); give afterwards
  await dbg('give', 'ak47');
  const before = await dbg('eventCount', 'shot');
  await dbg('setInput', { buttons: 1 }, 60);
  await dbg('stepTicks', 60);
  const shots = (await dbg('eventCount', 'shot')) - before;
  expect(shots >= 9 && shots <= 11, `≈ 10 AK shots in 1 s held, got ${shots}`);
  let s = await dbg('state');
  const human = () => s.players.find((p) => p.id === s.humanId);
  expect(human().inv.primary && human().inv.primary.id === 'ak47', 'holding the AK');
  const mag = human().inv.primary.mag, reserve = human().inv.primary.reserve;
  expect(mag === 30 - shots, `mag ${mag} after ${shots} shots`);
  await dbg('setInput', { buttons: 16 }, 1);
  await dbg('stepTicks', 200);
  s = await dbg('state');
  expect(human().inv.primary.mag === 30, `mag restored, got ${human().inv.primary.mag}`);
  expect(human().inv.primary.reserve === reserve - shots, `reserve ${human().inv.primary.reserve}`);
  expect((await dbg('eventCount', 'reload')) >= 3, 'reload start/mid/end events');
  await dbg('resume');
  await page.waitForTimeout(300);
  await shot('training-ak');
}

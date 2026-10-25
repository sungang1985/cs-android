/**
 * Audio smoke (§9.3) on the real WebAudio API: unlock() renders the bank (≈ 72 buffers), plays a spatialised
 * world sound through the panner chain, a UI click (direct and via a real button) and the ambient loop, without page errors.
 */
export default async function ({ page, url, expect, ready, dbg, log }) {
  await page.goto(url + 'index.html?test=1&seed=3', { waitUntil: 'load' });
  await ready();
  await dbg('startMatch', { mode: 'training', seed: 3 });
  const t0 = Date.now();
  const stats = await page.evaluate(async () => { const a = globalThis.__cs.game.audio; await a.unlock(); return a.stats(); });
  log(`bank: ${JSON.stringify(stats)} in ${Date.now() - t0} ms`);
  expect(stats.ready && stats.state === 'running', `audio unlocked and ready (${stats.state})`);
  expect(stats.buffers === 72, `72 buffers rendered (got ${stats.buffers})`);
  expect(stats.bytes > 1.5e6 && stats.bytes < 3.5e6, `bank size ≈ 2–3 MB (got ${stats.bytes})`);
  const voices = await page.evaluate(() => {
    const g = globalThis.__cs.game, a = g.audio, local = g.next.local;
    a.setListener({ pos: { x: local.eyeX, y: local.eyeY, z: local.eyeZ }, fwd: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } });
    a.handle({ type: 'sound', data: { id: 'fire_ak', pos: { x: local.eyeX + 6, y: 1.5, z: local.eyeZ }, loudness: 40, player: 9 }, tick: 10 }, local);
    a.handle({ type: 'hit', data: { attacker: local.id, victim: 9, weapon: 'usp', zone: 'head', damage: 100, armored: false, point: { x: 0, y: 0, z: 0 } }, tick: 10 }, local);
    a.ui('tap');
    a.startAmbient();
    return a.stats().voices;
  });
  expect(voices >= 3, `voices playing (got ${voices})`);
  const clickVoices = await page.evaluate(() => {
    const a = globalThis.__cs.game.audio, before = a.stats().voices;
    const b = document.createElement('button'); b.type = 'button'; b.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('ui').append(b); b.click(); b.remove();
    return a.stats().voices - before;
  });
  expect(clickVoices === 1, `a UI button click plays ui_tap through the app shell (got ${clickVoices})`);
  await dbg('stepTicks', 30);
  await page.waitForTimeout(300);
  await page.evaluate(() => { const a = globalThis.__cs.game.audio; a.stopAmbient(); a.suspend(); a.resume(); });
}

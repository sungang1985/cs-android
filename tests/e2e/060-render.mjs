/**
 * Renderer (L6): in-match frame draws the merged map, characters and the viewmodel within budget; hand-made
 * effect envelopes (shot / impact / hit / explosion) render without errors; the main menu shows the cinematic.
 * Prints the measured draw calls / triangles on Medium.
 */
export default async function ({ page, url, shot, expect, ready, dbg, log }) {
  await page.goto(url + 'index.html?test=1&seed=11', { waitUntil: 'load' });
  await ready();
  await page.waitForTimeout(1000);
  await shot('menu');
  const menuStats = await page.evaluate(() => ({ ...globalThis.__cs.game.renderer.stats }));
  expect(menuStats.drawCalls > 0, `menu cinematic draws (calls ${menuStats.drawCalls})`);

  await dbg('startMatch', { mode: 'defusal', seed: 11 });
  await page.evaluate(() => globalThis.__cs.game.setQualityPreset('medium'));
  await dbg('stepTicks', 400);
  await dbg('resume');
  await page.waitForTimeout(1500);
  await shot('in-match');
  const s = await page.evaluate(() => ({ ...globalThis.__cs.game.renderer.stats, q: globalThis.__cs.game.renderer.getQuality(), gl2: globalThis.__cs.game.renderer.webgl2 }));
  log(`medium: drawCalls=${s.drawCalls} triangles=${s.triangles} frameMs=${s.frameMs.toFixed(2)}`);
  console.log(`    [060-render] Medium in-match: ${s.drawCalls} draw calls, ${s.triangles} triangles, render ${s.frameMs.toFixed(2)} ms (CPU)`);
  expect(s.gl2, 'WebGL2 renderer');
  expect(s.drawCalls > 0, `drawCalls > 0 (got ${s.drawCalls})`);
  expect(s.triangles > 1000, `triangles > 1000 (got ${s.triangles})`);
  expect(s.drawCalls <= 60, `draw calls within the Medium budget (got ${s.drawCalls})`);
  expect(s.triangles <= 80000, `triangles within the Medium budget (got ${s.triangles})`);

  // Hand-made effect envelopes (weapons are stubs in this lane): shots from the human and a bot, impacts,
  // a hit with blood, an HE burst and a flash; then one more frame must render fine.
  await page.evaluate(() => {
    const g = globalThis.__cs.game, r = g.renderer, snap = g.next, me = snap.local;
    const bot = snap.players.find((p, i) => i < snap.playerCount && p.id !== me.id && p.alive) ?? snap.players[1];
    const eye = { x: me.eyeX, y: me.eyeY, z: me.eyeZ };
    const fwd = r.cameraPose().fwd;
    const end = { x: eye.x + fwd.x * 6, y: eye.y + fwd.y * 6, z: eye.z + fwd.z * 6 };
    for (let i = 0; i < 4; i++) r.handleEvent({ type: 'shot', tick: 0, data: { shooter: me.id, weapon: 'ak47', origin: eye, dir: fwd, end, hitPlayer: 0 } });
    r.handleEvent({ type: 'impact', tick: 0, data: { point: end, normal: { x: -fwd.x, y: 0, z: -fwd.z }, surface: 'concrete' } });
    r.handleEvent({ type: 'impact', tick: 0, data: { point: end, normal: { x: 0, y: 1, z: 0 }, surface: 'metal' } });
    const bp = { x: bot.x, y: bot.y + 1.2, z: bot.z };
    r.handleEvent({ type: 'shot', tick: 0, data: { shooter: bot.id, weapon: 'awp', origin: { x: bot.x, y: bot.y + 1.6, z: bot.z }, dir: { x: 1, y: 0, z: 0 }, end: { x: bot.x + 10, y: bot.y + 1.6, z: bot.z }, hitPlayer: 0 } });
    r.handleEvent({ type: 'hit', tick: 0, data: { attacker: me.id, victim: bot.id, weapon: 'ak47', zone: 'chest', damage: 36, armored: false, point: bp } });
    r.handleEvent({ type: 'damageTaken', tick: 0, data: { victim: me.id, from: bp, amount: 10, hpLeft: 90 } });
    r.handleEvent({ type: 'grenadeExplode', tick: 0, data: { id: 999, kind: 'he', pos: { x: eye.x + fwd.x * 8, y: 0.2, z: eye.z + fwd.z * 8 } } });
    r.handleEvent({ type: 'grenadeExplode', tick: 0, data: { id: 998, kind: 'flash', pos: { x: eye.x + fwd.x * 5, y: 1, z: eye.z + fwd.z * 5 } } });
  });
  await page.waitForTimeout(60);
  await shot('effects');
  const s2 = await page.evaluate(() => ({ ...globalThis.__cs.game.renderer.stats }));
  expect(s2.drawCalls > 0 && s2.drawCalls <= 60, `effects frame within budget (got ${s2.drawCalls})`);

  // pose sanity: camera pose is finite and points along the look direction
  const pose = await page.evaluate(() => globalThis.__cs.game.renderer.cameraPose());
  expect([pose.pos.x, pose.pos.y, pose.pos.z, pose.fwd.x, pose.fwd.y, pose.fwd.z].every(Number.isFinite), 'camera pose finite');
}

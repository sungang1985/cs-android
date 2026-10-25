/**
 * Renderer (L6): the main menu shows the cinematic backdrop; an in-match frame draws the merged map,
 * characters and the viewmodel within the Medium budget (≤ 60 draw calls, ≤ 80 k triangles); hand-made effect
 * envelopes (weapons are stubs in this lane) render without errors. Prints the measured Medium stats.
 * Screenshots: 060-render-menu, 060-render-in-match, 060-render-effects.
 */
export default async function ({ page, url, shot, expect, ready, dbg, log }) {
  await page.goto(url + 'index.html?test=1&seed=11', { waitUntil: 'load' });
  await ready();
  await page.waitForTimeout(1000);
  await shot('menu');
  const menu = await page.evaluate(() => ({ ...globalThis.__cs.game.renderer.stats }));
  expect(menu.drawCalls > 0, `menu cinematic draws (calls ${menu.drawCalls})`);

  await dbg('startMatch', { mode: 'defusal', seed: 11 });
  await page.evaluate(() => globalThis.__cs.game.setQualityPreset('medium')); // pins Medium (no auto step-down under SwiftShader)
  await dbg('stepTicks', 400);
  await dbg('resume');
  await page.waitForTimeout(1500);
  await shot('in-match');
  const s = await page.evaluate(() => { const r = globalThis.__cs.game.renderer; return { ...r.stats, q: r.getQuality(), gl2: r.webgl2 }; });
  log(`medium: drawCalls=${s.drawCalls} triangles=${s.triangles} frameMs=${s.frameMs.toFixed(2)}`);
  console.log(`    [060-render] ${s.q} in-match: ${s.drawCalls} draw calls, ${s.triangles} triangles, render CPU ${s.frameMs.toFixed(2)} ms`);
  expect(s.gl2 && s.q === 'medium', 'WebGL2 renderer on Medium');
  expect(s.drawCalls > 0, `drawCalls > 0 (got ${s.drawCalls})`);
  expect(s.triangles > 1000, `triangles > 1000 (got ${s.triangles})`);
  expect(s.drawCalls <= 60, `draw calls within the Medium budget (got ${s.drawCalls})`);
  expect(s.triangles <= 80000, `triangles within the Medium budget (got ${s.triangles})`);

  // Effects: stop the loop and drive frames by hand so the short-lived effects are on screen for the shot.
  const fx = await page.evaluate(() => {
    const g = globalThis.__cs.game, r = g.renderer;
    g.loop.stop();
    const look = g.input.previewLook(g.sim.aimCandidates(), g.next.local);
    const frame = (n) => { for (let i = 0; i < n; i++) r.render(g.prev, g.next, 1, look, 1 / 60); };
    frame(1);
    const snap = g.next, me = snap.local;
    const eye = { x: me.eyeX, y: me.eyeY, z: me.eyeZ }, fwd = r.cameraPose().fwd;
    const at = (d, dy = 0) => ({ x: eye.x + fwd.x * d, y: eye.y + fwd.y * d + dy, z: eye.z + fwd.z * d });
    const bot = snap.players.find((p, i) => i < snap.playerCount && p.id !== me.id && p.alive);
    for (let i = 0; i < 4; i++) r.handleEvent({ type: 'shot', tick: 0, data: { shooter: me.id, weapon: 'ak47', origin: eye, dir: fwd, end: at(30, -1), hitPlayer: 0 } });
    for (const [i, surface] of ['concrete', 'metal', 'wood', 'sand'].entries()) r.handleEvent({ type: 'impact', tick: 0, data: { point: at(4, -0.6 + i * 0.2), normal: { x: -fwd.x, y: 0, z: -fwd.z }, surface } });
    if (bot) {
      r.handleEvent({ type: 'shot', tick: 0, data: { shooter: bot.id, weapon: 'awp', origin: { x: bot.x, y: bot.y + 1.6, z: bot.z }, dir: { x: -fwd.x, y: 0, z: -fwd.z }, end: { x: bot.x - fwd.x * 20, y: bot.y + 1.6, z: bot.z - fwd.z * 20 }, hitPlayer: 0 } });
      r.handleEvent({ type: 'hit', tick: 0, data: { attacker: me.id, victim: bot.id, weapon: 'ak47', zone: 'chest', damage: 36, armored: false, point: { x: bot.x, y: bot.y + 1.2, z: bot.z } } });
    }
    r.handleEvent({ type: 'damageTaken', tick: 0, data: { victim: me.id, from: at(5), amount: 10, hpLeft: 90 } });
    r.handleEvent({ type: 'grenadeExplode', tick: 0, data: { id: 999, kind: 'he', pos: { ...at(9), y: 0.1 } } });
    r.handleEvent({ type: 'grenadeExplode', tick: 0, data: { id: 998, kind: 'flash', pos: at(6, 0.3) } });
    frame(2);
    return { ...r.stats };
  });
  await shot('effects');
  await page.evaluate(() => { // bomb explosion + white screen flash fade out (150 ms) without errors
    const g = globalThis.__cs.game, r = g.renderer, look = g.input.previewLook(g.sim.aimCandidates(), g.next.local);
    r.handleEvent({ type: 'bombExploded', tick: 0, data: { pos: { x: 40, y: 0, z: 30 } } });
    for (let i = 0; i < 12; i++) r.render(g.prev, g.next, 1, look, 1 / 60);
  });
  log(`effects frame: drawCalls=${fx.drawCalls} triangles=${fx.triangles}`);
  expect(fx.drawCalls > s.drawCalls && fx.drawCalls <= 60, `effects add draw calls and stay within budget (got ${fx.drawCalls})`);

  const pose = await page.evaluate(() => globalThis.__cs.game.renderer.cameraPose());
  expect([pose.pos.x, pose.pos.y, pose.pos.z, pose.fwd.x, pose.fwd.y, pose.fwd.z].every(Number.isFinite), 'camera pose finite');
}

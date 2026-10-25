/**
 * Touch look & fire (§12.2): drives the touch layer with synthetic touch PointerEvents on the overlay.
 * (a) floating joystick moves the human, (b) look-zone drag rotates yaw by Δpx · 0.176°, (c) Fire-R held sets
 * FIRE (and its drag rotates the view), (d) a 50 ms tap in the look zone latches one FIRE into the next command.
 */
const SENS_DEG_PER_PX = 0.022 * 8; // default sens 8, FOV 75

export default async function ({ page, url, expect, ready, dbg, shot, log }) {
  await page.goto(url + 'index.html?test=1&seed=2', { waitUntil: 'load' });
  await ready();
  await dbg('startMatch', { mode: 'training', seed: 2 });
  await page.waitForSelector('[data-testid="touch-layer"]', { state: 'attached', timeout: 10000 });
  await dbg('resume');

  // pointer helpers: positions in % of the viewport plus a px offset; moves are spread in time (≈ 250 px/s, below
  // the 400 px/s acceleration threshold) so the measured sensitivity is the base one
  const ptr = (type, id, xPct, yPct, dx = 0, dy = 0) => page.evaluate(([type, id, xPct, yPct, dx, dy]) => {
    const el = document.querySelector('[data-testid="touch-layer"]');
    const x = (innerWidth * xPct) / 100 + dx, y = (innerHeight * yPct) / 100 + dy;
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true }));
  }, [type, id, xPct, yPct, dx, dy]);
  const drag = (id, xPct, yPct, totalDx, totalDy, steps, stepMs) => page.evaluate(async ([id, xPct, yPct, totalDx, totalDy, steps, stepMs]) => {
    const el = document.querySelector('[data-testid="touch-layer"]');
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, stepMs));
      const x = (innerWidth * xPct) / 100 + (totalDx * i) / steps, y = (innerHeight * yPct) / 100 + (totalDy * i) / steps;
      el.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, buttons: 1, bubbles: true, cancelable: true }));
    }
  }, [id, xPct, yPct, totalDx, totalDy, steps, stepMs]);
  const human = async () => (await dbg('state')).players.find((p) => p.id === 1);
  const angDiff = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d <= -Math.PI) d += 2 * Math.PI; return d; };
  const lastButtons = () => page.evaluate(() => globalThis.__cs.game.sim.lastCommand.buttons);

  // (a) joystick: face south so a rightward push strafes west (the spawn has open floor to the west)
  let h = await human();
  await dbg('teleport', 1, h.pos.x, h.pos.y, h.pos.z, Math.PI);
  await page.waitForTimeout(100);
  h = await human();
  const x0 = h.pos.x;
  await ptr('pointerdown', 11, 15, 70);
  await drag(11, 15, 70, 60, 0, 6, 16);
  const joyVisible = await page.evaluate(() => document.querySelector('[data-testid="touch-joystick"]').classList.contains('is-active'));
  expect(joyVisible, 'joystick ring is active while the thumb is down');
  await page.waitForTimeout(1000);
  h = await human();
  log(`joystick: x ${x0.toFixed(2)} → ${h.pos.x.toFixed(2)}`);
  expect(Math.abs(h.pos.x - x0) >= 1, `joystick moved the human ≥ 1 m in x (moved ${(h.pos.x - x0).toFixed(2)} m)`);
  await ptr('pointerup', 11, 15, 70, 60, 0);
  await shot('joystick');

  // (b) look-zone drag of +200 px → yaw −200 · 0.176° (turning right is negative yaw)
  await page.waitForTimeout(150);
  const yaw0 = (await human()).yaw;
  await ptr('pointerdown', 12, 70, 40);
  await drag(12, 70, 40, 200, 0, 50, 16);
  await ptr('pointerup', 12, 70, 40, 200, 0);
  await page.waitForTimeout(200);
  const yaw1 = (await human()).yaw;
  const expected = -200 * SENS_DEG_PER_PX * (Math.PI / 180);
  const got = angDiff(yaw0, yaw1);
  log(`look: Δyaw ${(got * 180 / Math.PI).toFixed(2)}° (expected ${(expected * 180 / Math.PI).toFixed(2)}°)`);
  expect(Math.abs(got - expected) <= Math.abs(expected) * 0.1, `look drag rotates yaw by ≈ 200 × 0.176° (got ${(got * 180 / Math.PI).toFixed(2)}°)`);

  // (c) Fire-R held → FIRE bit in the stepped command; its drag also rotates the view (fire + look)
  await ptr('pointerdown', 13, 90, 72);
  await dbg('stepTicks', 1);
  expect(((await lastButtons()) & 1) === 1, 'Fire-R held → FIRE in the command');
  const yawF0 = (await human()).yaw;
  await drag(13, 90, 72, -100, 0, 25, 16);
  await dbg('stepTicks', 1);
  expect(((await lastButtons()) & 1) === 1, 'Fire-R still held while dragging');
  const gotF = angDiff(yawF0, (await human()).yaw);
  log(`fire-R drag: Δyaw ${(gotF * 180 / Math.PI).toFixed(2)}°`);
  expect(gotF > 0 && Math.abs(gotF - 100 * SENS_DEG_PER_PX * (Math.PI / 180)) <= 0.1 * 100 * SENS_DEG_PER_PX * (Math.PI / 180), 'Fire-R drag rotates the view');
  await ptr('pointerup', 13, 90, 72, -100, 0);
  await dbg('stepTicks', 1);
  expect(((await lastButtons()) & 1) === 0, 'FIRE released after Fire-R up');

  // (d) a 50 ms tap in the look zone (loop paused by stepTicks) → the next sampled command has FIRE, once
  await ptr('pointerdown', 14, 70, 40);
  await page.waitForTimeout(50);
  await ptr('pointerup', 14, 70, 40);
  await dbg('stepTicks', 1);
  expect(((await lastButtons()) & 1) === 1, 'tap-to-fire latched FIRE into the next command');
  await dbg('stepTicks', 1);
  expect(((await lastButtons()) & 1) === 0, 'tap-to-fire is a single tick');

  // Buy pill is visible in training (buy anywhere) and the inert band ignores touches
  const buyShown = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="touch-buy"]')).display !== 'none');
  expect(buyShown, 'Buy pill visible while canBuy');
  await dbg('resume');
  await page.waitForTimeout(200);
  await shot('controls');
}

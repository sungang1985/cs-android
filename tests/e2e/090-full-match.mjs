/** Full match smoke (§12.2): three seeds, human idle, synchronous batch stepping to MATCH_END; no exceptions; stats persisted. */
export default async function ({ page, url, shot, expect, ready, dbg, log }) {
  await page.goto(url + 'index.html?test=1&seed=1', { waitUntil: 'load' });
  await ready();
  for (const seed of [1, 2, 3]) {
    const t0 = Date.now();
    await dbg('startMatch', { mode: 'defusal', seed, teamSize: 3, roundsToWin: 4, difficulty: seed === 3 ? 'hard' : 'normal' });
    let phase = await dbg('phase'); let guard = 0;
    while (phase !== 'MATCH_END' && guard++ < 120) { await dbg('stepTicks', 600); phase = await dbg('phase'); }
    const s = await dbg('state');
    log(`seed ${seed}: ${phase} after ${s.tick} ticks, score ${s.round.scoreT}:${s.round.scoreCT}, rounds ${s.round.roundNumber}, ${Date.now() - t0} ms`);
    expect(phase === 'MATCH_END', `seed ${seed} reached MATCH_END (got ${phase})`);
    expect(s.round.scoreT === 4 || s.round.scoreCT === 4 || (s.round.scoreT === 3 && s.round.scoreCT === 3), `seed ${seed} has a decided score ${s.round.scoreT}:${s.round.scoreCT}`);
    expect((await dbg('eventCount', 'death')) > 5, `seed ${seed} had kills`);
    expect(s.players.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.yaw)), 'finite state');
    expect(Date.now() - t0 < 90000, `seed ${seed} within 90 s wall`);
    await page.waitForSelector('[data-testid="screen-matchEnd"]', { timeout: 5000 });
  }
  await shot('match-end');
  const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('cs.v1.stats') || 'null'));
  expect(stats && stats.matches >= 3, `lifetime stats persisted: ${JSON.stringify(stats)}`);
}

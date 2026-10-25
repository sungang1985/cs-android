/**
 * Rules e2e (§12.2 "Round flow", synchronous variant): defusal seed 5 with the human on T, bots frozen, the human
 * gets the C4, stands on plant spot A (compiled: cell (20,2) → world (41, 1.5, 5)), holds USE → planted; 35 s later
 * the bomb explodes → T win, score 1:0, money deltas listed.
 */
export default async function ({ page, url, expect, ready, dbg, shot }) {
  await page.goto(url + 'index.html?test=1&seed=5', { waitUntil: 'load' });
  await ready();
  await dbg('startMatch', { mode: 'defusal', seed: 5, humanTeam: 'T', teamSize: 5, roundsToWin: 6 });
  await page.waitForSelector('[data-testid="hud"]', { timeout: 10000 });
  await dbg('freezeBots', true);
  await dbg('stepTicks', 1);
  expect((await dbg('phase')) === 'FREEZE', 'round 1 starts in FREEZE');
  let s = await dbg('state');
  expect(s.round.buyWindowEndsTick === 900, `buy window ends at tick 900, got ${s.round.buyWindowEndsTick}`);
  expect(s.players.filter((p) => p.hasBomb).length === 1, 'exactly one C4 carrier at FREEZE');
  await dbg('stepTicks', 305);
  expect((await dbg('phase')) === 'LIVE', 'FREEZE → LIVE');

  await dbg('give', 'c4');
  await dbg('teleport', 1, 41, 1.5, 5);
  await dbg('stepTicks', 2);
  await dbg('setInput', { buttons: 32 }, 200);
  await dbg('stepTicks', 200);
  s = await dbg('state');
  expect(s.bomb.state === 'planted', `bomb planted, got ${s.bomb.state}`);
  expect(s.bomb.site === 'a', `planted at site A, got ${s.bomb.site}`);
  expect((await dbg('eventCount', 'bombPlanted')) === 1, 'one bombPlanted event');
  await dbg('stepTicks', 2);
  expect((await dbg('phase')) === 'PLANTED', 'phase PLANTED after the plant');
  const snap = await dbg('snapshot');
  expect(snap.bomb.state === 3 && snap.bomb.remaining > 30, `snapshot shows the planted bomb timer (${snap.bomb.remaining})`);
  await shot('planted');

  await dbg('stepTicks', 35 * 60 + 10);
  const phase = await dbg('phase');
  expect(phase === 'ROUND_END' || phase === 'FREEZE', `round over after the explosion, got ${phase}`);
  s = await dbg('state');
  expect(s.round.scoreT === 1 && s.round.scoreCT === 0, `score T 1 : 0 CT, got ${s.round.scoreT}:${s.round.scoreCT}`);
  const ends = await dbg('events', 'roundEnd', 1);
  expect(ends.length === 1 && ends[0].winner === 'T' && ends[0].reason === 'bomb', `roundEnd T bomb, got ${JSON.stringify(ends[0] && { w: ends[0].winner, r: ends[0].reason })}`);
  expect(ends[0].deltas.some((d) => d.reason === 'win' && d.delta === 3500), 'T win money $3,500 listed');
  expect((await dbg('eventCount', 'bombExploded')) === 1, 'one bombExploded event');
  await shot('round-end');
}

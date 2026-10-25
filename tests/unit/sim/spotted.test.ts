/** The human's `spotted` events come from step() once per tick; aimCandidates() (called every frame) is pure. */
import { describe, it, expect } from 'vitest';
import { dirFromYawPitch } from '@/core/math';
import type { SimEvents } from '@/sim/events';
import { harness, humanCmd, stepUntilPhase, teleport } from '../rules/helpers';

describe('human spotted events', () => {
  function setup() {
    const h = harness();
    stepUntilPhase(h, 'LIVE');
    const me = h.human();
    const enemy = h.sim.state.players.find((p) => p.team !== me.team)!;
    const f = dirFromYawPitch(me.yaw, 0);
    teleport(enemy, me.pos.x + f.x * 3, me.pos.y, me.pos.z + f.z * 3);
    h.sim.events.drain();
    return { h, me, enemy };
  }
  it('aimCandidates() never emits: paused frames do not queue events', () => {
    const { h, enemy } = setup();
    const tickEvents = (h.sim as unknown as { tickEvents: unknown[] }).tickEvents, before = tickEvents.length;
    for (let i = 0; i < 600; i++) expect(h.sim.aimCandidates().map((c) => c.id)).toContain(enemy.id);
    expect(h.sim.events.drain()).toHaveLength(0);
    expect(tickEvents).toHaveLength(before);
  });
  it('step() emits the human spotted once per tick', () => {
    const { h, me, enemy } = setup();
    for (let i = 0; i < 3; i++) {
      h.sim.aimCandidates();
      h.sim.step(humanCmd(h));
      const spotted = h.sim.events.drain().filter((e) => e.type === 'spotted').map((e) => e.data as SimEvents['spotted']).filter((d) => d.by === me.id && d.enemy === enemy.id);
      expect(spotted).toEqual([expect.objectContaining({ team: me.team, enemy: enemy.id, by: me.id })]);
    }
  });
});

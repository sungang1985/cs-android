/** Radar (§8.1). DAY-0 STUB: draws walls, self and teammates on a 2D canvas (functional but plain). L6 polishes. */
import type { CompiledMap } from '../world/types';
import type { RenderSnapshot, Spotted } from '../sim/state';

export class Radar {
  private readonly ctx: CanvasRenderingContext2D | null;
  private walls: CompiledMap['renderHints']['radarWalls'] = [];
  readonly radiusM = 18;
  constructor(private readonly canvas: HTMLCanvasElement) { this.ctx = canvas.getContext('2d'); }
  loadMap(map: CompiledMap): void { this.walls = map.renderHints.radarWalls; }
  draw(next: RenderSnapshot, spotted: Spotted[], yaw: number): void {
    const c = this.ctx; if (!c) return;
    const w = this.canvas.width, h = this.canvas.height, s = w / (2 * this.radiusM);
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(10,12,16,0.7)'; c.beginPath(); c.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); c.fill();
    c.save(); c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 1, 0, Math.PI * 2); c.clip();
    c.translate(w / 2, h / 2); c.rotate(yaw); c.scale(s, s); c.translate(-next.local.x, -next.local.z);
    c.strokeStyle = '#9aa3ad'; c.lineWidth = 1 / s;
    c.beginPath(); for (const wl of this.walls) { c.moveTo(wl.x0, wl.z0); c.lineTo(wl.x1, wl.z1); } c.stroke();
    const myTeam = next.players.find((p) => p.id === next.local.id)?.team ?? 0;
    for (let i = 0; i < next.playerCount; i++) {
      const p = next.players[i]; if (!p.alive || p.id === next.local.id) continue;
      if (p.team === myTeam) { c.fillStyle = '#4FC3F7'; c.beginPath(); c.arc(p.x, p.z, 0.6, 0, Math.PI * 2); c.fill(); }
    }
    c.fillStyle = '#FF7043';
    for (const sp of spotted) { if (next.tick - sp.tick < 180) { c.beginPath(); c.arc(sp.x, sp.z, 0.6, 0, Math.PI * 2); c.fill(); } }
    if (next.bomb.state >= 1) { c.fillStyle = '#FFD54F'; c.fillRect(next.bomb.x - 0.5, next.bomb.z - 0.5, 1, 1); }
    c.restore();
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(w / 2, h / 2 - 6); c.lineTo(w / 2 - 4, h / 2 + 4); c.lineTo(w / 2 + 4, h / 2 + 4); c.closePath(); c.fill();
  }
}

/**
 * Radar (§8.1): 2D canvas, rotates with the player's yaw (forward = up), 18 m radius; walls from
 * renderHints.radarWalls, self arrow, teammates blue, enemies red for 3 s after a `spotted` event (list from the
 * app), bomb icon (own team T: carried / dropped / planted; CT: planted only), site letters A/B at the site
 * centres (clamped to the rim), planted bomb blinking. Drawn at 20 Hz by the app.
 */
import type { CompiledMap } from '../world/types';
import type { RenderSnapshot, Spotted } from '../sim/state';

const COL = { bg: 'rgba(10,12,16,0.72)', rim: 'rgba(255,255,255,0.25)', wall: '#9aa3ad', mate: '#4FC3F7', enemy: '#FF7043', bomb: '#FFD54F', site: '#FFD54F', self: '#ffffff' };
const SPOT_TICKS = 180;

export class Radar {
  private readonly ctx: CanvasRenderingContext2D | null;
  private walls: CompiledMap['renderHints']['radarWalls'] = [];
  private sites: { label: string; x: number; z: number }[] = [];
  readonly radiusM = 18;
  constructor(private readonly canvas: HTMLCanvasElement) { this.ctx = canvas.getContext('2d'); }

  loadMap(map: CompiledMap): void {
    this.walls = map.renderHints.radarWalls;
    this.sites = (['a', 'b'] as const).map((k) => { const r = map.sites[k]; return { label: k.toUpperCase(), x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }; });
    // match the backing store to the CSS size × DPR so lines stay crisp
    const cw = this.canvas.clientWidth, dpr = typeof devicePixelRatio === 'number' ? Math.min(2, devicePixelRatio) : 1;
    if (cw > 0) { const px = Math.round(cw * dpr); if (px !== this.canvas.width) { this.canvas.width = px; this.canvas.height = px; } }
  }

  /** World (x, z) → radar pixels for a given centre/yaw/scale (forward = up). */
  static project(x: number, z: number, cx: number, cz: number, yaw: number, scale: number, half: number): { x: number; y: number } {
    const dx = x - cx, dz = z - cz, c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: half + (dx * c - dz * s) * scale, y: half + (dx * s + dz * c) * scale };
  }

  draw(next: RenderSnapshot, spotted: Spotted[], yaw: number): void {
    const c = this.ctx; if (!c) return;
    const W = this.canvas.width, half = W / 2, scale = half / this.radiusM, l = next.local;
    let cx = l.x, cz = l.z;
    // dead + spectating: centre on the spectated teammate
    if (!l.alive && l.spectating) for (let i = 0; i < next.playerCount; i++) { const p = next.players[i]; if (p.id === l.spectating) { cx = p.x; cz = p.z; } }
    c.clearRect(0, 0, W, W);
    c.fillStyle = COL.bg; c.beginPath(); c.arc(half, half, half - 1, 0, Math.PI * 2); c.fill();
    c.save(); c.beginPath(); c.arc(half, half, half - 2, 0, Math.PI * 2); c.clip();
    c.translate(half, half); c.rotate(yaw); c.scale(scale, scale); c.translate(-cx, -cz);
    c.strokeStyle = COL.wall; c.lineWidth = 1.6 / scale; c.lineCap = 'round';
    c.beginPath(); for (const wl of this.walls) { c.moveTo(wl.x0, wl.z0); c.lineTo(wl.x1, wl.z1); } c.stroke();
    const me = next.players.find((p, i) => i < next.playerCount && p.id === l.id);
    const myTeam = me ? me.team : 0;
    const dot = (x: number, z: number, r: number, col: string) => { c.fillStyle = col; c.beginPath(); c.arc(x, z, r, 0, Math.PI * 2); c.fill(); };
    for (let i = 0; i < next.playerCount; i++) {
      const p = next.players[i];
      if (!p.alive || p.id === l.id || p.team !== myTeam) continue;
      dot(p.x, p.z, 0.75, COL.mate);
    }
    for (const sp of spotted) if (next.tick - sp.tick < SPOT_TICKS) {
      const alive = next.players.some((p, i) => i < next.playerCount && p.id === sp.enemy && p.alive);
      if (alive) dot(sp.x, sp.z, 0.75, COL.enemy);
    }
    // bomb: T sees carried / dropped / planted; CT only the planted bomb (it blinks)
    const b = next.bomb;
    const planted = b.state === 3;
    if (planted || (myTeam === 0 && (b.state === 1 || b.state === 2))) {
      let bx = b.x, bz = b.z;
      if (b.state === 1) for (let i = 0; i < next.playerCount; i++) if (next.players[i].id === b.carrier) { bx = next.players[i].x; bz = next.players[i].z; }
      const blinkOn = !planted || Math.floor(next.time * 4) % 2 === 0;
      if (blinkOn) { c.fillStyle = planted ? '#ff4a3a' : COL.bomb; c.fillRect(bx - 0.6, bz - 0.4, 1.2, 0.8); }
    }
    c.restore();
    // site letters stay upright; clamp to the rim when out of range
    c.font = `bold ${Math.round(W * 0.11)}px system-ui, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const s of this.sites) {
      let p = Radar.project(s.x, s.z, cx, cz, yaw, scale, half);
      const dx = p.x - half, dy = p.y - half, d = Math.hypot(dx, dy), maxR = half - W * 0.08;
      if (d > maxR) p = { x: half + (dx / d) * maxR, y: half + (dy / d) * maxR };
      c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillText(s.label, p.x + 1, p.y + 1);
      c.fillStyle = COL.site; c.fillText(s.label, p.x, p.y);
    }
    c.strokeStyle = COL.rim; c.lineWidth = 1; c.beginPath(); c.arc(half, half, half - 1, 0, Math.PI * 2); c.stroke();
    // self arrow
    const a = W * 0.045;
    c.fillStyle = COL.self; c.beginPath(); c.moveTo(half, half - a * 1.3); c.lineTo(half - a, half + a); c.lineTo(half, half + a * 0.5); c.lineTo(half + a, half + a); c.closePath(); c.fill();
  }
}

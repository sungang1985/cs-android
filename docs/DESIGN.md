# CS-Android — Final Design Document (v1.0, "弹壳 / Shell")

> A Counter-Strike-style, single-player-vs-bots FPS for Android phones. TypeScript + Three.js (r0.186) bundled with esbuild into a static PWA, wrapped by a thin Kotlin WebView app. Zero downloaded assets: textures from Canvas2D, models from primitives, audio from WebAudio synthesis. Deterministic 60 Hz simulation in pure TypeScript; rendering, input, audio and UI are thin adapters.
>
> This is the binding specification for the ~8 engineers implementing the modules in §11 in parallel. Where this document and an earlier draft disagree, this document wins. The repository already contains the L1 core kernel (`src/core/{math,rng,events,loop}.ts`, `src/sim/world/collision.ts`) and the build/e2e tooling (`tools/`, `web/`, `android/`); their conventions are adopted here and are frozen.

## 0. Conventions (apply everywhere)

| Topic | Convention |
|---|---|
| Units | metres, seconds, kilograms-free; money in `$`; angles are **radians in code** (`DEG = π/180` from `core/math.ts`); this document quotes **degrees** for readability. |
| Axes | Y-up, right-handed. **+x = east, +z = south** (ASCII map row index grows southward), **−z = north**. |
| Yaw / pitch | Three.js `rotation.y` convention: `forward = (−sin yaw, 0, −cos yaw)`. yaw 0 = north (−z), **+90° = west**, **−90° = east**, ±180° = south. Pitch positive = looking up, clamped ±89°. `yawFromDir(d) = atan2(−d.x, −d.z)`. |
| Grid ↔ world | Map cell `(cx, cz)` (2 m cells) has world centre `(2·cx + 1, floorY, 2·cz + 1)`; cell rect spans `[2cx, 2cx+2) × [2cz, 2cz+2)`. |
| Time | Fixed tick `DT = 1/60 s`; sim time `t = tick / 60`; no wall-clock anywhere inside `src/{core,world,maps,nav,weapons,rules,ai,sim,i18n}`. |
| Player body | AABB positioned by its **feet centre** (existing `StaticWorld.moveBody`): half-width **0.3 m**, height **1.8 m** standing / **1.3 m** crouched, eye height **1.65 / 1.15 m**, step-up **0.5 m**. |
| Entity ids | `EntityId = number`, allocated once per match, never reused (§11.4). Human player is always id **1**. |
| Randomness | Only through `RngStreams` (sfc32, named streams; state is plain numbers stored in `WorldState`). `Math.random`, `Date`, `performance` are banned in pure folders (lint + tsconfig `lib: ["ES2022"]` without DOM). |
| Localisation | zh-CN is the source dictionary; English must have every key. UI copy below is shown as `中文 / English`. |

---

## 1. Vision & scope

**Vision.** A recognisably Counter-Strike match (T/CT, buy phase, bomb defusal, Glock/USP/Deagle/MP5/AK/M4/AWP, HE + flash, economy, recoil you can learn) where every decision is driven by two thumbs on a 6–6.7" phone held in landscape: rounds ≤ 75 s, a 3-second buy, aim assist you can trust, big readable HUD, a locked 60 fps, and a whole match (first to 6) inside a 10-minute bus ride.

**Design pillars (used to settle every argument).**

| Pillar | Concrete rule |
|---|---|
| Thumbs first | No action needs more than one thumb movement; nothing important sits where a thumb cannot reach in 150 ms; every control has a stated position, size and hit margin (§7.2). |
| Short loop | Freeze 5 s + round ≤ 75 s (+35 s bomb); match first-to-6 ≈ 8–12 min; "再来一局 / Play again" is one tap; dead players can fast-forward (4×) to round end. |
| Readable at 6" | Minimum HUD text 14 CSS px; enemies are bright, saturated team colours on dark floors; ≤ 2 colours per HUD element. |
| Fair assist | Aim assist = friction + drag-gated magnetism on the body only, never auto-headshot; bots are never affected by the assist setting; the stats screen records the assist level used. |
| Always 60 | Frame budget 16.6 ms: ≤ 9 ms GPU, ≤ 2 ms sim (10 players, 9 bots), ≤ 2 ms render sync, rest headroom; Low/Medium/High/Auto presets; no shadow maps. |
| Deterministic core | 60 Hz fixed step, named seeded RNG streams inside the serialisable state, zero DOM/Three.js in the sim; a golden-hash test guards every PR. |

### 1.1 In v1

- **Modes:** Bomb Defusal (primary), Team Deathmatch (practice, respawn), Training range (static targets; drives onboarding).
- **Map:** one map, "Depot / 货场", 48 × 36 m, 2 sites, 3 lanes, one raised site (+1.5 m), authored hold spots.
- **Teams:** 5v5 (human + 4 friendly bots vs 5 enemy bots); 3v3 and 2v2 selectable.
- **Weapons:** knife, Glock-18, USP-S, Desert Eagle, MP5-SD, AK-47, M4A4, AWP, HE grenade, flashbang; Kevlar, Kevlar+Helmet, defuse kit, C4.
- **Economy:** CS-style (loss-bonus ladder, kill rewards, plant/defuse bonuses, 15 s buy window), quick-buy presets, auto-buy option, shared bot/human buy planner.
- **Bots:** FSM bots with perception (FOV, LOS, hearing with confidence), team blackboard, derived 1 m nav grid + authored hold spots, plant/defuse/ninja-defuse, stuck recovery, 3 difficulties.
- **Controls:** floating joystick, drag-look, fire buttons (R and L), contextual Use pill, tap-to-fire, aim assist (Off/Low/Medium/High), optional gyro, auto-fire option, drag-editable layout, left-handed mirror; desktop mouse + keyboard.
- **Rendering:** Three.js WebGL2, Lambert/Phong, procedural textures, primitive models, separate viewmodel pass, tracers/decals/particles pools, quality presets, battery saver (30 fps cap).
- **Audio:** ~45 synthesised buffers, equal-power panning, distance attenuation, 1-ray occlusion, compressor, haptics.
- **UI:** zh-CN default + EN toggle, main menu, mode select, settings, buy menu, pause, scoreboard, round/match end, stats, onboarding, orientation gate.
- **Platform:** PWA (offline service worker, installable) + Android WebView wrapper (immersive, back button, haptics, safe insets, audio focus, gyro bridge); `localStorage` persistence incl. "continue last match".

### 1.2 Explicitly out of v1

Multiplayer/networking/accounts/analytics/ads; smoke grenades and molotovs (volumetric LOS blocking is a frame-time and AI cost we do not take); hostage mode; more maps (the data format allows them); weapon skins, voice lines, custom fonts; skeletal animation/ragdolls (we tip-over); ladders, water, destructibles; portrait orientation; gamepad (trivial later); iOS-specific work (should mostly run).

---

## 2. Game modes & rules

### 2.1 Common constants

| Parameter | Value | Note |
|---|---|---|
| Sim tick | 60 Hz, `DT = 1/60`; ≤ 4 catch-up steps per frame then time is dropped | `core/loop.ts` |
| Team size | 5v5 default (settings: 3v3, 2v2); human = slot 0 of chosen team | ≤ 9 bots |
| HP / armor | 100 / 0–100 (Kevlar sets 100; helmet is a flag) | |
| Max speed | per weapon (§4.1): knife 5.0 m/s … AWP 4.0 (3.3 scoped) | ≈ CS 250 u/s = 4.76 m/s |
| Walk (silent) | 0.52 × max speed (joystick 30–75 % or desktop Shift) | no footstep events |
| Crouch | 0.5 × max speed; body height 1.3 m; eye 1.15 m | can't un-crouch under a 1.4 m clearance |
| Acceleration | ground 40 m/s² to target velocity, friction 8 /s; air control 1.5 m/s² | reaches max in ≈ 0.3 s |
| Jump | impulse **6.0 m/s** up, gravity **20 m/s²** → apex **0.90 m**, airtime 0.6 s | 1 m crate = apex 0.9 + step-up 0.5 ✓ |
| Fall damage | `max(0, (vImpact − 9) × 10)` HP (vImpact = downward speed at landing) | rare on Depot |
| Friendly fire | **Off**: bullets, knife and HE ignore teammates; flash **does** blind teammates | no team-kill economy rules |
| Round-end slow-mo | 0.5× for 1.5 s on the final kill (kill-cam), then 2.5 s scoreboard at 1× | `loop.timeScale` |

### 2.2 Bomb Defusal (爆破模式) — primary

| Phase | Duration | Notes |
|---|---|---|
| `FREEZE` | **5 s** | movement locked; buy menu auto-opens in round 1 of each half; otherwise the 购买 pill pulses |
| Buy window | **FREEZE (5 s) + first 10 s of LIVE = 15 s**, only inside own spawn area (`t_spawn` / `ct_spawn`) | one definition, used by `rules/economy.ts` and the HUD countdown |
| `LIVE` | **75 s** | CT win on expiry if no plant |
| `PLANTED` | **35 s** bomb timer | plant takes 3.0 s (hold Use, speed < 0.5 m/s, inside site); defuse 7.0 s / 3.5 s with kit |
| `ROUND_END` | 4 s | banner, kill-cam, money deltas; money is resolved at the start of this phase |
| Half | after round `roundsToWin − 1` (5 at first-to-6): swap sides, money → $800, loss streaks → 0 | |
| Match | **first to 6** (settings: 4 / 6 / 8). At `(n−1):(n−1)` one `SUDDEN_DEATH` round decides | 8–12 min |
| `SUDDEN_DEATH` | 60 s, no buy, no bomb; everyone spawns with team rifle + Kevlar+Helmet + default pistol; elimination wins; expiry = **draw** | draw is a stored match result |

**Win conditions and rewards** (winner reward; see §5 for loss side):

| Event | Winner | Reason id | Team reward |
|---|---|---|---|
| All CT dead | T | `elimination` | $3,250 |
| Bomb explodes | T | `bomb` | $3,500 |
| All T dead, bomb not planted | CT | `elimination` | $3,250 |
| Bomb defused | CT | `defuse` | $3,500 |
| Timer expires without plant | CT | `time` | $3,250 |
| All T dead after plant | — | round continues until explode/defuse | |
| Sudden death: all enemies dead | that team | `elimination` | money untouched |

- **Respawn:** none. Dead players spectate alive teammates (chase cam; swipe/arrow to cycle) and get a **「跳过回合 / Skip」** button that sets `timeScale = 4` until `ROUND_END` (bots keep thinking at full fidelity; rendering continues).
- **Bomb carrier:** one random alive T (stream `spawn`) receives C4 at FREEZE; the human is eligible (icon on HUD). If the carrier dies the bomb becomes a world item (`items[]`, kind `bomb`); any T walking over it picks it up; bots path to it (§6.8).
- **Continue match:** `WorldState` is serialised to `localStorage` at every FREEZE start; resuming restarts the current round (never mid-round).

### 2.3 Team Deathmatch (团队死斗)

- 5v5, **4 min** or first team to **30** kills; respawn 2 s after death at the own-team spawn farthest from the nearest enemy (min 12 m), 2 s spawn invulnerability.
- Economy disabled: buy menu opens anywhere, any time (sim keeps running); items are free; a "respawn loadout" is remembered.
- Bots use `PLAN → MOVE → ENGAGE → HUNT` only (no bomb logic). Scoring: kill = 1.

### 2.4 Training range (训练场)

- Solo, Depot `t_spawn + t_north + long` only (other areas sealed by an invisible solid list), 8 pop-up targets (`targets[]`, box men 0.5×1.8×0.3 m at fixed cells in Long) that drop when hit and pop back after 2 s. Infinite money, no timer.
- Hosts onboarding (§7.6): 3 guided 20-second tasks (move / aim & fire / buy).

### 2.5 Round state machine (`rules/round.ts`)

```
          start                 5 s                     plant
WARMUP ─────────► FREEZE ─────────────► LIVE ───────────────────► PLANTED
   ▲                 ▲                   │  all CT dead → T        │ explode → T
   │                 │                   │  all T dead → CT        │ defuse  → CT
   │                 │                   │  75 s      → CT         │ (all T dead: keep going)
   │                 │                   ▼                          ▼
   │                 │            ROUND_END (4 s; money resolved on entry)
   │                 │                   │
   │                 ├─ next round ◄─────┤ (half reached → swap sides, money $800)
   │                 ├─ (n−1):(n−1) ─────┤ → SUDDEN_DEATH (60 s) → ROUND_END → MATCH_END
   │                 └───────────────────┴─ rounds won == n → MATCH_END {winner | 'draw'}
   └── TDM: FREEZE(3 s) → LIVE(240 s) → MATCH_END ; respawns handled by rules/modes/tdm.ts
```

Every transition emits `roundPhase`, and `ROUND_END` additionally emits `roundEnd { winner, reason, mvp }`, `MATCH_END` emits `matchEnd { result: 'win'|'lose'|'draw', score }` (§11.5).

---

## 3. Map design — "Depot / 货场"

### 3.1 Overview

- Footprint **48 m (x, east) × 36 m (z, south)**; cell size **2 m**; grid **24 × 18**. Interior walls 3 m, a ceiling solid at **4.5 m** (indoor warehouse: no sky, no directional shadows needed).
- Three lanes: **Long / 长廊** (north) to A, **Mid / 中庭** (centre) to CT spawn, **Tunnel / 隧道** (south) to B; two connectors (A-connector and B-connector) and two "windows" (single-cell openings between Long↔Mid and Mid↔Tunnel).
- **A site is a +1.5 m platform** reached by two 2 m ramps (west ramp from Long, south ramp from CT spawn) and overlooks Long through two **lip walls** (1.9 m high: a standing defender on the platform sees over them; a standing attacker in Long cannot).
- Timing at rifle speed (4.3 m/s): T → A **41 m ≈ 9.5 s**, T → B **41 m ≈ 9.5 s**, CT → A **14.5 m ≈ 3.4 s**, CT → B **14.5 m ≈ 3.4 s**, CT rotation A ↔ B **≈ 26.5 m ≈ 6 s**. CTs always set up first; Ts fight into a held site, as in CS.

### 3.2 ASCII layout (row = z, col = x; top row is north; each glyph = one 2 × 2 m cell)

```
      000000000011111111112222
      012345678901234567890123
 00   ########################
 01   #......#.........L^AAA^#
 02   #......+.........=^AAA^#
 03   #......#....c....LcAAA^#
 04   ####.######.##X..#^^^^^#
 05   #....#............####=#
 06   #.T.#......cc.....X..C.#
 07   #.T.#..XX......~...#.C.#
 08   #T..+..........~.....C.#
 09   #T..+..........~.....C.#
 10   #.T.#..XX......~...#.C.#
 11   #...#......cc.....X....#
 12   #....#............####+#
 13   ####.######.##X..#X....#
 14   #......#.........#XBBB.#
 15   #......+.........+.BBB.#
 16   #......#.........#cBBB.#
 17   ########################
```

All 18 rows are exactly 24 characters; the compiler asserts this. **Glyphs never encode height**: the floor height of a walkable cell is `platformY` if the cell lies inside a platform rect, else 0; props sit on that local floor.

**Legend**

| Glyph | Meaning | Collision (local floor `f`) | LOS | Bullets |
|---|---|---|---|---|
| `#` | wall | solid `f … 3.0 m` (merged runs) | blocks | stop |
| `.` | floor | walkable | — | — |
| `^` | platform floor (readability only; compiler treats as `.`) | walkable at `f = 1.5` | — | — |
| `+` | doorway (open cell, rendered with a frame, lintel solid 2.6–3.0 m) | walkable | — | lintel stops |
| `X` | tall crate | solid `f … f+2.0`, full cell | blocks | AWP only, ×0.4 |
| `c` | low crate, 1.0 m cube centred in the cell (0.5 m margin) | solid `f … f+1.0` | blocks crouched targets / legs only | penetrable ×0.6 (thickness ≤ 1.0 m) |
| `~` | sandbags | solid `f … f+1.2`, full cell | blocks crouched targets | penetrable ×0.6 |
| `L` | lip wall (A platform edge) | solid `0 … 1.9` (floor 0 side) | one-way: see over from the +1.5 platform | stop |
| `=` | ramp: 4 stair boxes of 0.5 m depth rising 0.375 m each toward the `ascend` neighbour | climbed by step-up (0.5 m) | stair boxes block LOS/bullets | stop |
| `A` / `B` | bomb-site zone (plant allowed); A cells are also platform floor | walkable | — | — |
| `T` / `C` | spawn cells (5 each) | walkable | — | — |

**Named areas (callouts, HUD, bot strategy; cell rects inclusive):**

| Area id | Cells (x0, z0, x1, z1) | zh-CN | en | Floor |
|---|---|---|---|---|
| `t_spawn` | (1, 5, 4, 12) | T出生点 | T Spawn | 0 |
| `t_north` | (1, 1, 6, 3) | 北仓 | North Room | 0 |
| `t_south` | (1, 14, 6, 16) | 南仓 | South Room | 0 |
| `long` | (8, 1, 16, 3) | 长廊 | Long | 0 |
| `mid` | (5, 5, 18, 12) | 中庭 | Mid Yard | 0 |
| `tunnel` | (8, 14, 16, 16) | 隧道 | Tunnel | 0 |
| `ct_spawn` | (19, 6, 22, 11) | CT出生点 | CT Spawn | 0 |
| `site_a` | (18, 1, 22, 4) | A点 | A Site | **1.5 (platform)** |
| `site_b` | (18, 13, 22, 16) | B点 | B Site | 0 |
| `a_ramp` | (17, 2, 17, 2) | A坡 | A Ramp | ramp 0→1.5 east |
| `a_ramp_ct` | (22, 5, 22, 5) | A后坡 | A Back Ramp | ramp 0→1.5 north |
| `mid_window` | (11, 4, 11, 4) | 天窗 | Mid Window | 0 |
| `tunnel_window` | (11, 13, 11, 13) | 地窗 | Tunnel Window | 0 |
| `a_connector` | (15, 4, 16, 4) | A连接 | A Connector | 0 |
| `b_connector` | (15, 13, 16, 13) | B连接 | B Connector | 0 |
| `b_door_ct` | (22, 12, 22, 12) | B后门 | B Back Door | 0 |

Plant zones: **A = cells (19..21, 1..3)**, **B = cells (19..21, 14..16)**. Plant spots used by bots: `A (20, 2)`, `B (20, 15)`.

**Spawns** (cell, yaw; index 0 is the human's slot):

| T (face east, yaw −90°) | CT (face west, yaw +90°) |
|---|---|
| (2,6), (2,7), (1,8), (1,9), (2,10) | (21,8), (21,9), (21,7), (21,10), (21,6) |

**Authored hold spots** (`holdSpots[]`; cell, facing yaw, team, crouch). "Facing" uses §0's convention (−90° = east, +90° = west, 180° = south, 0° = north).

| id | Cell | Yaw | Team | Crouch | Covers |
|---|---|---|---|---|---|
| `hold_a_lip` | (18,1) | +90° | CT | yes | Long, over lip `L` (17,1) |
| `hold_a_crate` | (19,3) | +90° | CT | no | ramp top, behind `c` (18,3) |
| `hold_a_back` | (22,4) | +90° | CT | no | whole platform from the back ramp |
| `hold_b_crate` | (19,13) | 135° | CT | no | tunnel door (17,15), behind `X` (18,13..14) |
| `hold_b_lowcrate` | (19,16) | +90° | CT | yes | tunnel door, behind `c` (18,16) |
| `hold_sandbags_n` | (16,7) | +90° | CT | yes | mid, behind `~` (15,7) |
| `hold_sandbags_s` | (16,10) | +90° | CT | yes | mid, behind `~` (15,10) |
| `hold_ct_pocket` | (19,6) | 135° | CT | no | mid from behind `X` (18,6) |
| `postplant_a_w` | (18,1) | −127° | T | yes | back ramp top (22,4) |
| `postplant_a_e` | (22,1) | 180° | T | no | back ramp (22,5) |
| `postplant_b_n` | (19,13) | −90° | T | no | CT door (22,12) |
| `postplant_b_s` | (22,16) | 0° | T | yes | CT door approach (22,13) |
| `lurk_a_connector` | (16,4) | 180° | T | no | mid from the A connector |
| `lurk_b_connector` | (16,13) | 0° | T | no | mid from the B connector |
| `hold_long_crate` | (11,3) | −90° | both | yes | Long east, behind `c` (12,3) |

### 3.3 Height

- A platform: solid slab `x 36..46, y 0..1.5, z 2..10` (cells 18..22 × 1..4) with floor height 1.5; crate `c` at (18,3) sits at `y 1.5..2.5`. Ceiling 4.5 m: a jumping player on the platform (feet 2.4 m + 1.8 m body = 4.2 m) just clears it.
- Ramps `(17,2)` (ascending east) and `(22,5)` (ascending north): four stair boxes each `0.5 m` deep, tops at 0.375 / 0.75 / 1.125 / 1.5 m. Walk-up uses the existing step-up logic (0.5 ≥ 0.375); bots traverse them like floor.
- Low crates (1.0 m) are jump-mountable (vantage over mid from (11,6)/(12,6) and (11,11)/(12,11)); tall crates (2.0 m) are not.

### 3.4 Sightlines & chokepoints

| Sightline | From → To | Length | Notes |
|---|---|---|---|
| Long | (8,2) → (16,2) | 18 m | AWP lane; `c` (12,3) is the only cover; platform defenders peek over the lips |
| Mid north | (5,6) → (17,6) | 24 m | low crates (11..12,6) hide crouchers only; `X` (18,6) ends it |
| Mid south | (5,11) → (17,11) | 24 m | mirror |
| Mid cross | (9,8) → (14,8) | 10 m | sandbag line at x = 15 favours CT (shoot over standing, hide crouched) |
| Tunnel | (8,15) → (16,15) | 18 m | straight; T must rush or peek |
| A platform | (18,2) → (22,2) | 10 m | close quarters, crate (18,3) |
| B site | (18,15) → (22,15) | 10 m | `X` (18,13..14) and `c` (18,16) frame the tunnel door |

| Chokepoint | Cell | Width | Typical holder |
|---|---|---|---|
| Long door | (7,2) | 2 m | T entering Long |
| Mid doors | (4,8), (4,9) | 4 m | T exit; CT can push |
| Tunnel door | (7,15) | 2 m | T |
| Mid window | (11,4) | 2 m | both (Long ↔ Mid flank) |
| Tunnel window | (11,13) | 2 m | both (Mid ↔ Tunnel flank) |
| A ramp (west) | (17,2) | 2 m | CT holds from the platform |
| A back ramp | (22,5) | 2 m | CT rotation path |
| B tunnel door | (17,15) | 2 m | CT holds behind the crates |
| B back door | (22,12) | 2 m | CT rotation path |
| Sandbag line | (15,7..10) | — | CT cover line facing mid |

### 3.5 Map as data (`src/maps/depot.ts`, pure data; `src/world/compile.ts` compiles it)

```ts
export type Glyph = '#' | '.' | '^' | '+' | 'X' | 'c' | '~' | 'L' | '=' | 'A' | 'B' | 'T' | 'C';
export type Cell = [cx: number, cz: number];
export type CellRect = [x0: number, z0: number, x1: number, z1: number];   // inclusive
export type MaterialId = 'concrete' | 'concrete_base' | 'floor' | 'floor_stripe' | 'crate_wood' | 'sandbag' | 'metal' | 'door_frame' | 'ceiling' | 'lamp' | 'site_marker' | 'skin_t' | 'skin_ct' | 'gun_metal' | 'wood_stock';
export type SurfaceId = 'concrete' | 'wood' | 'metal' | 'sand';            // footsteps & impacts (subset of collision.ts SurfaceId)

export interface MapSource {
  id: string; name: { zh: string; en: string };
  cellSize: 2; width: 24; height: 18;
  grid: string[];                                            // 18 strings × 24 glyphs
  wallHeight: 3.0; ceilingY: 4.5; lintelY: 2.6;
  props: Record<'X' | 'c' | '~' | 'L', { height: number; inset: number; material: MaterialId; surface: SurfaceId; penetrable: boolean; penetrationFactor: number; blocksLos: 'full' | 'low' }>;
  platforms: { rect: CellRect; y: number; material: MaterialId; surface: SurfaceId }[];
  ramps: { cell: Cell; ascend: 'n' | 's' | 'e' | 'w'; from: number; to: number; steps: 4 }[];
  areas: { id: AreaId; rect: CellRect; name: { zh: string; en: string } }[];
  sites: { a: CellRect; b: CellRect };
  plantSpots: { a: Cell; b: Cell };
  spawns: { T: { cell: Cell; yawDeg: number }[]; CT: { cell: Cell; yawDeg: number }[] };   // index 0 = human slot
  holdSpots: { id: string; cell: Cell; yawDeg: number; team: 'T' | 'CT' | 'both'; crouch: boolean }[];
  chokes: { id: string; cell: Cell }[];
  materials: { wall: MaterialId; wallBase: MaterialId; floor: MaterialId; site: MaterialId; ceiling: MaterialId; door: MaterialId };
  training?: { sealed: CellRect[]; targets: Cell[] };       // training range variant
}
```

`compileMap(src): CompiledMap` (deterministic, unit-tested):

1. **Solids** — greedy merge of horizontal runs of identical `#` cells, then vertical merge of identical rows (Depot: ≈ 70 wall boxes instead of 190 cells); one box per prop cell (`X`, `c`, `~`, `L`), `c` inset 0.5 m; platform slabs; 4 stair boxes per ramp; door lintels; one ceiling slab. Each solid carries `{ surface, penetrable, penetrationFactor, blocksLos, material, kind }`; `kind: 'ramp-step'` solids are used by raycasts and LOS but are climbable by `moveBody` via step-up. Expected total for Depot: **≈ 110 solids**.
2. **Floor function** — `floorY(x, z)` = platform height inside platform rects, else 0 (`StaticWorld.floorHeightAt` handles stairs/crates by probing solids).
3. **Walk grid** — 1 m sub-grid (48 × 36): a sub-cell is walkable if a standing body AABB (0.6 × 1.8 × 0.6) centred on it at the local floor overlaps no solid except ramp steps (whose tops are reachable by step-up); stores `floorY` per sub-cell. Depot: ≈ 1,150 walkable sub-cells → nav nodes (§6.4).
4. **World-space data** — areas, sites, plant spots, spawns, hold spots, chokes converted to metres; `areaAt(x, z)`.
5. **Render hints** — the solid list with materials and per-face UV scale (1 repeat per 2 m), ramp wedge params, door frames, lamp positions (one per 4 × 4 m of floor), site decal quads. The renderer consumes only `renderHints`, never the grid.

Compiler assertions (tests): every row is 24 glyphs; every `T`/`C` count is 5; every cell in a platform rect is one of `^ A c X # =`-compatible glyphs; each ramp's `from` neighbour floor equals `from` and `to` neighbour equals `to`; every spawn sub-cell is walkable; BFS over the walk grid reaches both sites and the enemy spawn from each spawn; no two solids overlap; all solids lie inside bounds.

<!-- CONTINUE -->

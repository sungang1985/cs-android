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

---

## 4. Weapons

### 4.1 Weapon table (metres, seconds, degrees; real CS names)

`Speed` = max move speed holding the weapon. `Spread` = cone half-angle (°) of the first shot: standing / moving at max speed / crouched. `Per-shot` = inaccuracy added per unit of heat (°); `Recover` = heat lost per second. `Falloff` = damage multiplier per 10 m. `AP` = armor penetration. `Pen` = may continue through penetrable props (factor).

| id | Name | Type | Price | Dmg body / head | RPM | Mag / reserve | Reload | Spread stand / move / crouch | Per-shot / recover | Pattern | Speed | Falloff | AP | Pen | Kill $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `knife` | 匕首 Knife | melee | — | slash 40 / stab 65 (backstab stab ×3 = 195) | slash 120 (0.5 s) / stab 60 (1.0 s) | — | — | — | — | — | 5.0 | — | 0.85 | — | 1,500 |
| `glock` | Glock-18 | pistol, semi | 200 (T default) | 30 / 120 | 400 | 20 / 120 | 2.2 | 1.2 / 4.0 / 0.85 | 0.35 / 10 | `P_pistol` | 4.8 | 0.90 | 0.47 | no | 300 |
| `usp` | USP-S | pistol, semi | 200 (CT default) | 35 / 140 | 350 | 12 / 24 | 2.2 | 0.9 / 3.5 / 0.65 | 0.35 / 10 | `P_pistol` | 4.8 | 0.91 | 0.50 | no | 300 |
| `deagle` | 沙漠之鹰 Desert Eagle | pistol, semi | 700 | 53 / 212 | 267 | 7 / 35 | 2.2 | 1.0 / 5.0 / 0.7 | 2.5 / 5 | `P_deagle` | 4.6 | 0.87 | 0.93 | ×0.5 | 300 |
| `mp5` | MP5-SD | SMG, auto | 1,500 | 27 / 108 | 750 | 30 / 120 | 2.6 | 1.0 / 2.0 / 0.7 | 0.25 / 9 | `P_smg` | 4.7 | 0.85 | 0.62 | no | 600 |
| `ak47` | AK-47 | rifle, auto (T) | 2,700 | 36 / 144 | 600 | 30 / 90 | 2.5 | 0.8 / 5.5 / 0.55 | 0.45 / 6 | `P_ak` | 4.3 | 0.98 | 0.77 | ×0.6 | 300 |
| `m4a4` | M4A4 | rifle, auto (CT) | 3,100 | 33 / 132 | 666 | 30 / 90 | 3.1 | 0.6 / 5.0 / 0.45 | 0.35 / 7 | `P_m4` | 4.4 | 0.97 | 0.70 | ×0.6 | 300 |
| `awp` | AWP | sniper, bolt | 4,750 | 115 / 460 (legs 85 fixed) | 41 (1.46 s bolt) | 5 / 30 | 3.6 | unscoped 8.0 / 12 / 7; scoped 0.05 / 6.0 / 0.04 | 0 / — | `P_awp` | 4.0 (3.3 scoped) | 0.99 | 0.97 | ×0.6; through `X` ×0.4 | 100 |
| `he` | 高爆手雷 HE Grenade | throwable | 300 (max 1) | 98 at 0 m → 0 at 3.5 m, linear | 1 throw / s | 1 | — | — | — | — | 4.9 | — | 0.50 | — | 300 |
| `flash` | 闪光弹 Flashbang | throwable | 200 (max 2) | 0; blind ≤ 3.0 s | 1 throw / s | 1 each | — | — | — | — | 4.9 | — | — | — | — |

Gear: `kevlar` $650 (armor → 100), `kevlar_helmet` $1,000 (armor → 100 + helmet), **helmet upgrade $350** when armor > 0 and no helmet; rebuying Kevlar with armor < 100 costs $650 and refills. `defuse_kit` $400 (CT only, 1). `c4`: T objective item. Rifles are team-locked in the buy menu (`teams: ['T']` / `['CT']`); dropped rifles can be picked up by anyone.

**Hit zones:** head ×4.0, chest ×1.0, stomach ×1.25, legs ×0.75 (AWP legs = 85 fixed, no armor). Armor applies to chest/stomach always, to head only with helmet, never to legs.

```
d        = round(base · falloff^(dist / 10) · zoneMult)
if armored(zone): armorDmg = d · (1 − AP) · 0.5;  d = round(d · AP);  armor = max(0, armor − ceil(armorDmg));  if armor == 0: helmet = false
```
AK head with helmet at 10 m: 144 × 0.98 × 0.77 = 108.6 → kill. AK body at 30 m: 36 × 0.98³ = 33.9 → 34. Deagle head with helmet: 212 × 0.93 = 197 → kill.

**Penetration:** at most one. If the first hit is a `penetrable` solid whose thickness along the ray ≤ 1.2 m and the weapon has a `Pen` factor, the ray continues from the exit point with `d × Pen`. Walls `#`, lips `L`, lintels, platform slabs and ramp steps stop everything; tall crates `X` stop everything except the AWP (×0.4).

**Timings:** weapon switch 0.5 s (to knife 0.25 s); deploy after purchase 1.0 s; reload is cancelled by switching and completes only at its end (no partial); AWP: 1.46 s bolt, auto re-scope after bolt (setting "开镜保持", default on), zoom 75° → 20° → 10° → unscoped; scoped sensitivity scales by `fov / 75`.

### 4.2 Spread (inaccuracy) model — `weapons/fire.ts`, pure

```
σ_pose = speed < 0.3 ? (crouched ? σ_crouch : σ_stand) : lerp(σ_stand, σ_move, clamp(speed / maxSpeed, 0, 1))
θ      = σ_pose · (1 + 3.0 · airborne) + perShot · heat                // cone half-angle, degrees
heat  += 1 per shot;  heat = max(0, heat − recover · DT) per tick
```
Shot direction = `dir(look.yaw + aimOffset.yaw, look.pitch + aimOffset.pitch)` rotated by a random offset uniform over the disc: `ρ = θ · sqrt(u1)`, `φ = 2π · u2`, `u1, u2` from stream **`spread`**. AWP uses `σ_scoped` when scoped; unscoped AWP is deliberately 8°.

### 4.3 Recoil model ("aim punch shown at half strength") — `weapons/fire.ts`

Each weapon has a pattern `P[i] = (pitch_i, yaw_i)` in degrees for shot index `i`. On every shot:

- `shotIndex` (float) increments by 1; while not firing it decays `shotIndex = max(0, shotIndex − recoveryRate · DT)` with `recoveryRate` = AK 6/s, M4 7/s, MP5 9/s, pistols 10/s; the pattern index is `min(floor(shotIndex), P.length − 1)`.
- **Aim offset** (where bullets go): `aimOffset += P[i] · (1 + N(0, 0.08))` (stream `fire`), then every tick `aimOffset *= exp(−DT / 0.45)`; clamped to pitch ≤ 12°, |yaw| ≤ 6°. With τ = 0.45 s an AK spray (0.1 s between shots) loses only 20 % per shot, so the steady-state climb is ≈ 9°: the player **must** drag down to keep hitting.
- **Camera** = `look + 0.5 · aimOffset` (the view kick is half the aim punch; no separate state). The crosshair is drawn at the projection of `look + aimOffset`, i.e. it visibly climbs on screen during a spray and the player pulls `look.pitch` down to bring it back ("动态准星 / recoil crosshair", default on; off = fixed centre crosshair, CS-purist).
- `look` is the player's own absolute view angles from `InputCommand`; recoil never modifies `look`, so the input layer and the sim never fight over it.
- Mobile tuning: patterns are CS-shaped scaled to **60 %** amplitude (already applied below).

Patterns (`weapons/patterns.ts`; pitch up positive, yaw right positive; tests assert length 30 for autos and monotone non-decreasing pitch for shots 0–7):

| Pattern | pitch[0..29] | yaw[0..29] |
|---|---|---|
| `P_ak` | 0.4 0.9 1.3 1.6 1.8 1.9 2.0 2.0 2.1 2.1 2.0 2.0 2.0 2.0 2.0 1.9 1.9 1.9 1.9 1.9 then 1.8 ×10 | 0 0.05 −0.1 −0.2 −0.3 −0.6 −0.8 −1.0 −1.1 −1.2 −1.0 −0.5 0 0.4 0.8 1.0 0.9 0.7 0.5 0.4 then +0.6/−0.6 alternating ×10 |
| `P_m4` | 0.3 0.7 1.0 1.3 1.5 then 1.6 ×10 then 1.5 ×5 then 1.4 ×10 | 0 0.05 0.1 0.15 0.2 0.4 0.55 0.7 0.8 0.9 0.8 0.5 0.2 −0.2 −0.6 −0.8 −0.7 −0.5 −0.3 −0.2 then +0.4/−0.4 alternating ×10 |
| `P_smg` | 0.2 0.4 0.6 0.8 0.9 then 1.0 ×25 | 0 0 0.1 0.1 −0.1 then +0.3/−0.3 alternating ×25 |
| `P_pistol` | [1.2] (length 1; index never grows) | [0] |
| `P_deagle` | [3.0, 3.0] | [+0.3, −0.3] |
| `P_awp` | [6.0] | [0] |

### 4.4 Firing, hit detection, melee, grenades

- **Trigger:** semi-auto fires once per press edge (the input layer latches a sub-tick tap into one `FIRE` tick); auto fires every `60 / RPM` s while held; `AWP`: shot → 1.46 s bolt → re-scope. Dry fire emits `dryFire`. Auto-reload (setting, default on): when the magazine is empty and no enemy has been visible for 0.8 s.
- **Hitscan** (`weapons/hitscan.ts`): ray from eye along the shot direction, max 200 m, against (a) `StaticWorld.raycastAll` and (b) every alive enemy's hitboxes in the victim's yaw-local frame: head sphere r 0.16 at feet + 1.60 (crouched 1.10); torso box 0.5 × 0.6 × 0.3 at y 0.9–1.5 (chest = upper 55 %, stomach = lower 45 %); legs box 0.5 × 0.9 × 0.3 at y 0–0.9. Crouched: torso y 0.6–1.1, legs 0–0.6. Nearest `t` wins; teammates are skipped (friendly fire off). Emits `shot`, `hit`, `impact`, `nearMiss` (ray passes < 1.5 m from a player's head).
- **Knife:** sphere-cast r 0.3 m, reach 1.2 m, 60° cone; backstab when the angle between the victim's forward and attacker→victim is < 60°.
- **Grenades** (`weapons/grenade.ts`): sphere r 0.07; release speed 12 m/s (or **7 m/s "short toss"** when the throw button was held < 300 ms… see §7.2: tap = full throw, hold = short toss) at +10° above aim; gravity 20 m/s²; swept-sphere vs solids, restitution 0.45, friction 0.7, sub-stepped ×4 when speed > 10 m/s; players ignored. HE fuse 2.0 s, flash 1.5 s, both from release. Trajectory preview dots (render-only) while the throw button is held.
- **HE damage:** `98 · max(0, 1 − dist / 3.5)` to every enemy whose chest **or** head has LOS from the burst centre; armor rule with AP 0.5; thrower cannot hurt teammates or self? — self-damage **on** (CS rule), teammates **off**.
- **Flash:** for each player (both teams) within 20 m with LOS: `blind = 3.0 · clamp(cos α, 0, 1)^0.7 · clamp(1 − dist / 20, 0.25, 1)` s (α = angle between view direction and direction to the flash). Human: white overlay alpha 1 → 0 over `blind` plus a 3.5 kHz ring; bots: perception disabled, 50 % spray toward the last known target direction.
- **World items** (`items[]`): death drops the primary weapon (and C4); a `drop` button (pause menu, desktop G) drops the active primary. Auto-pickup fills an empty matching slot when walking over an item; otherwise the Use pill reads 「拾取 / Pick up」 and swaps. Bots pick up a better gun within 6 m of their path and always retrieve a dropped bomb (§6.8).

---

## 5. Economy (Defusal only; TDM and Training are free)

| Item | Value |
|---|---|
| Starting money (match start and side swap) | $800 |
| Max money | $16,000 |
| Round win: elimination / time | $3,250 to each winner |
| Round win: bomb exploded / defused | $3,500 to each winner |
| Loss bonus ladder (team loss streak 1 … 5+) | $1,400 / $1,900 / $2,400 / $2,900 / $3,400 |
| Loss streak update | on a loss `streak += 1`; on a win `streak = max(0, streak − 1)` (CS "half-step" rule); both reset to 0 at the half |
| T lose after planting | **+ $800 to every T** (on top of the loss bonus) |
| Plant | **+ $300 to the planter**, paid immediately on plant |
| Defuse | + $300 to the defuser, paid immediately |
| Kill reward | by weapon (§4.1): knife $1,500 · pistols $300 · MP5 $600 · AK/M4 $300 · AWP $100 · HE $300 |
| Ts alive when the timer expires (CT `time` win) | those Ts receive **$0** loss bonus (CS anti-camping rule) |
| Suicide / fall death | no change |
| Sudden death | money untouched, no buying |
| Buy window | FREEZE 5 s + first 10 s of LIVE = **15 s**, inside own spawn area only |
| Sell / refund | none |

Money is applied by `rules/economy.ts` in exactly two places: immediately for plant/defuse/kill, and once on entering `ROUND_END` for win/loss (`awardRoundEnd` returns a `MoneyDelta[]` that the HUD lists). All amounts clamp at $16,000.

### 5.1 Buy menu structure (one screen, no sub-menus; layout in §8.4)

| 手枪 Pistols | 冲锋枪 & 步枪 SMG & Rifles | 狙击 & 装备 Sniper & Gear | 投掷物 Grenades |
|---|---|---|---|
| Glock / USP ($200, team), Deagle $700 | MP5-SD $1,500; AK-47 $2,700 (T) / M4A4 $3,100 (CT) | AWP $4,750; Kevlar $650; Kevlar+Helmet $1,000 (upgrade $350); 拆弹器 Defuse kit $400 (CT) | HE $300 (max 1); Flash $200 (max 2) |

Quick-buy row (top of the menu, large tiles with price and 「可负担 / 钱不够」 state):

| Preset | Contents | Price (T / CT) |
|---|---|---|
| 「全装 / Full」 | team rifle + Kevlar+Helmet + HE + Flash (+ kit for CT if affordable) | $4,200 / $4,600 (+400) |
| 「半甲 / Force」 | Kevlar + Deagle | $1,350 |
| 「狙击 / AWP」 | AWP + Kevlar+Helmet | $5,750 |
| 「自动 / Auto」 | result of `buyPlan()` below | varies |
| 「重买 / Rebuy」 | last round's purchases, in order, skipping what is already owned | varies |

A preset buys its items in order and stops at the first unaffordable one. Setting 「自动购买 / Auto-buy」 (default off) runs `buyPlan()` at FREEZE start so a player never has to open the menu.

### 5.2 Shared buy planner (`rules/buyPlan.ts`, used by bots and by 「自动」)

```
buyPlan(money, team, owned, prefs, teamLossStreak, teamHasAwp, isLastRoundOfHalf): ItemId[]
  rifle = team == 'T' ? 'ak47' : 'm4a4'
  if prefs.sniper && !teamHasAwp && money ≥ 5750           → [awp, kevlar_helmet] + he if ≥ +300 + flash if ≥ +200
  elif money ≥ price(rifle) + 1000                        → [rifle, kevlar_helmet] + he if ≥ +300 + flash if ≥ +200 + kit (CT) if ≥ +400
  elif money ≥ 2500                                       → [mp5, kevlar_helmet]
  elif money ≥ 1350                                       → [deagle, kevlar]
  elif money ≥ 650 && (teamLossStreak ≥ 2 || isLastRoundOfHalf) → [kevlar]
  else                                                    → []            // eco
Items already owned are skipped; helmet is bought as the $350 upgrade when Kevlar is owned.
```
Bots add a team-coordinated eco (§6.7): if the team's average money < $2,000 and no one can afford a rifle, all bots of that team buy nothing and keep their pistols.

<!-- CONTINUE -->

# CS-Android — Final Design Document (v1.0, "弹壳 / Shell")

> A Counter-Strike-style, single-player-vs-bots FPS for Android phones. TypeScript + Three.js (r0.186) bundled with esbuild into a static PWA, wrapped by a thin Kotlin WebView app. Zero downloaded assets: textures from Canvas2D, models from primitives, audio from WebAudio synthesis. Deterministic 60 Hz simulation in pure TypeScript; rendering, input, audio and UI are thin adapters.
>
> This is the binding specification for the ~8 engineers implementing the modules in §11 in parallel. Where this document and an earlier draft disagree, this document wins. The repository already contains the L1 core kernel (`src/core/{math,rng,events,loop}.ts`, `src/sim/world/{collision,nav}.ts`, `src/app/{persist,bridge}.ts`, `src/audio/dsp.ts`, `src/i18n/i18n.ts`) and the build/e2e tooling (`tools/`, `web/`, `android/`). **Their public APIs are adopted verbatim** (this document was reconciled against the code: `FixedLoop.pause(p: boolean)`, `window.CSNative`/`__csBack`, `getLocale()`, `audio/dsp.ts` names, `globalThis.__cs` test hooks, esbuild `iife`); §11.15 lists, file by file, what is kept, moved or deleted.

## 0. Conventions (apply everywhere)

| Topic | Convention |
|---|---|
| Units | metres, seconds, kilograms-free; money in `$`; angles are **radians in code** (`DEG = π/180` from `core/math.ts`); this document quotes **degrees** for readability. Runtime fields are radians **including** `PlayerState.aimOffset`, `InputCommand.yaw/pitch`, `SnapLocal.aimOffsetYaw/Pitch` and `LookPreview`; only fields whose names end in `Deg` (`spreadDeg`, `yawDeg`, `fovDeg`) and the data tables in `weapons/defs.ts`/`patterns.ts` hold degrees, and `applyRecoil`/`computeSpread` convert them with `DEG` at the point of use. |
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

**Vision.** A recognisably Counter-Strike match (T/CT, buy phase, bomb defusal, Glock/USP/Deagle/MP5/AK/M4/AWP, HE + flash, economy, recoil you can learn) where every decision is driven by two thumbs on a 6–6.7" phone held in landscape: rounds ≤ 75 s, a 5-second freeze with a 15-second buy window, aim assist you can trust, big readable HUD, a locked 60 fps, and a whole match (first to 6) inside a 10-minute bus ride.

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
| Sim tick | 60 Hz, `DT = 1/60`; `app/game.ts` constructs `FixedLoop` with `maxSteps: 8` (the loop's own default stays 4 for its unit tests), so 「跳过回合」 at `timeScale 4` still runs 4× under the 30 fps cap (8 steps/frame ≈ 2 ms); beyond that time is dropped | `core/loop.ts` |
| Team size | 5v5 default (settings: 3v3, 2v2); human = slot 0 of chosen team | ≤ 9 bots |
| HP / armor | 100 / 0–100 (Kevlar sets 100; helmet is a flag) | |
| Max speed | per weapon (§4.1): knife 5.0 m/s … AWP 4.0 (3.3 scoped) | ≈ CS 250 u/s = 4.76 m/s |
| Walk (silent) | 0.52 × max speed whenever `walk` is true (§7.8: `WALK` bit **or** `0 < |move| ≤ 0.75`); speed is **binary** (0.52× or 1×), never proportional to stick travel | no footstep events |
| Crouch | 0.5 × max speed; body height 1.3 m; eye 1.15 m | can't un-crouch under a 1.4 m clearance |
| Acceleration | ground 40 m/s² to target velocity, friction 8 /s; air control 1.5 m/s² | reaches max in ≈ 0.3 s |
| Jump | impulse **6.0 m/s** up, gravity **20 m/s²** → apex **0.90 m**, airtime 0.6 s | 1 m crate = apex 0.9 + step-up 0.5 ✓ |
| Fall damage | `max(0, (vImpact − 9) × 10)` HP (vImpact = downward speed at landing) | rare on Depot |
| Friendly fire | **Off**: bullets, knife and HE ignore teammates; flash **does** blind teammates | no team-kill economy rules |
| Round-end slow-mo | `app/game.ts` sets `loop.timeScale = 0.5` when it drains the `roundEnd` event (emitted by `tickRound` on the tick after the final kill; the kill-cam uses `SnapLocal.lastKill`, written at the death tick) for **1.5 s wall = 0.75 s sim = 45 ticks**, then back to 1×; the remaining 195 ticks of the 4 s `ROUND_END` = **3.25 s wall** show the scoreboard. `timeScale` is forced to 1 on every `roundPhase` event and on quit | `loop.timeScale`, app-owned only |

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

- **Plant / defuse progress (human and bots alike, `rules/bomb.ts`):** progress starts on a `USE` press (emits `bombPlantStart` / `bombDefuseStart { kit }`) and advances only while `USE` stays held, horizontal speed < 0.5 m/s, the player is alive, inside the site (plant) / within 1.5 m of the bomb (defuse), not switching weapons and not blind. The moment any condition fails, progress **resets to 0** (it never pauses) and `bombPlantStop` / `bombDefuseStop` is emitted exactly once. Taking damage does **not** interrupt (CS rule); §6.8's "> 20 damage" is a bot *decision* to release `USE`. `SnapPlayer.using = 1` while in progress; `SnapLocal.useAction/useProgress` drive the ring.
- **Respawn:** none. Dead players spectate alive teammates (chase cam). The **sim** owns the spectated id: on death `SnapLocal.spectating` = the alive teammate with the lowest id (0 if none); `InputCommand.spectate` (−1 / +1, §7.8; swipe in the look zone or ◁ ▷ on the spectator bar, arrow keys on desktop) cycles it by ascending id with wrap-around. The **「跳过回合 / Skip」** button emits UI action `skipRound`; `app/game.ts` sets `loop.timeScale = 4` until the next `roundPhase` event (bots keep thinking at full fidelity; rendering continues).
- **Bomb carrier:** one random alive T (stream `spawn`) receives C4 at FREEZE; the human is eligible (icon on HUD). If the carrier dies the bomb becomes a world item (`items[]`, kind `bomb`); any T walking over it picks it up; bots path to it (§6.8).
- **Continue match:** `WorldState` is serialised to `localStorage` at every FREEZE start; resuming restarts the current round (never mid-round).

### 2.3 Team Deathmatch (团队死斗)

- 5v5, **4 min** or first team to **30** kills; respawn 2 s after death at the own-team spawn farthest from the nearest enemy (preferring spawns ≥ 12 m away; if none qualifies the spawn with the largest nearest-enemy distance is used, ties by spawn index), 2 s spawn invulnerability. `tickRound` passes `rng.get('spawn')` to `GameMode.respawn`.
- Economy disabled: buy menu opens anywhere, any time (sim keeps running); items are free; a "respawn loadout" is remembered.
- Bots use `PLAN → MOVE → ENGAGE → HUNT` only (no bomb logic). Scoring: kill = 1.

### 2.4 Training range (训练场)

- Solo, Depot `t_spawn + t_north + long` only: the app compiles the same `depot` source with `compileMap(depot, 'training')`, which turns `training.sealed` rects into invisible solids (`kind: 'seal'`, skipped by the renderer and the radar). 8 pop-up targets (`targets[]`, box men 0.5×1.8×0.3 m at the cells in `depot.training.targets`, created by `createMatch` from `map.training.targets`) drop when hit (`resolveHitscan` tests `targets` and returns `HitResult.kind = 'target'`; the weapon step emits `targetHit`) and pop back after 120 ticks (`rules/modes/training.ts#tick`, emits `targetReset`; no randomness). Infinite money, no timer.
- Hosts onboarding (§7.6): 3 guided 20-second tasks (move / aim & fire / buy). The move-task marker is `depot.training.onboardingCell` = (5, 2) in North Room; `ui/onboarding.ts` reads `RenderSnapshot.local.x/z` to detect arrival and asks the app (UI action `marker`) to call `renderer.setMarker(pos | null)`.

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

Every transition emits `roundPhase`, and `ROUND_END` additionally emits `roundEnd { winner, reason, mvp }`, `MATCH_END` emits `matchEnd { result: Team | 'draw', scoreT, scoreCT }` (§11.5); the UI derives 胜利 / 失败 from `cfg.humanTeam`.

---

## 3. Map design — "Depot / 货场"

### 3.1 Overview

- Footprint **48 m (x, east) × 36 m (z, south)**; cell size **2 m**; grid **24 × 18**. Interior walls 3 m, a ceiling solid at **4.5 m** (indoor warehouse: no sky, no directional shadows needed).
- Three lanes: **Long / 长廊** (north) to A, **Mid / 中庭** (centre) to CT spawn, **Tunnel / 隧道** (south) to B; two connectors (A-connector and B-connector) and two "windows" (single-cell openings between Long↔Mid and Mid↔Tunnel).
- **A site is a +1.5 m platform** reached by two 2 m ramps (west ramp from Long, south ramp from CT spawn) and overlooks Long through two **lip walls** (1.9 m high: a standing defender on the platform sees over them; a standing attacker in Long cannot).
- Timing at rifle speed (4.3 m/s), measured by cell-centre BFS without corner cutting (string-pulled nav paths are 5–10 % shorter): T → A **≈ 46 m ≈ 10.5 s**, T → B **≈ 47 m ≈ 11 s**, CT → A **≈ 14.5 m ≈ 3.4 s**, CT → B **≈ 18 m ≈ 4.2 s**, CT rotation A ↔ B **≈ 33 m ≈ 7.5 s**. CTs always set up first; Ts fight into a held site, as in CS.

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

### 3.5 Map as data (`src/maps/depot.ts`, pure data; the types below live in `src/world/types.ts` so adapters can import them; `src/world/compile.ts` compiles it)

```ts
export type Glyph = '#' | '.' | '^' | '+' | 'X' | 'c' | '~' | 'L' | '=' | 'A' | 'B' | 'T' | 'C';
export type Cell = [cx: number, cz: number];
export type CellRect = [x0: number, z0: number, x1: number, z1: number];   // inclusive
export type MaterialId = 'concrete' | 'concrete_base' | 'floor' | 'floor_stripe' | 'crate_wood' | 'sandbag' | 'metal' | 'door_frame' | 'ceiling' | 'lamp' | 'site_marker' | 'skin_t' | 'skin_ct' | 'gun_metal' | 'wood_stock';
export type SurfaceId = 'concrete' | 'wood' | 'metal' | 'sand';            // footsteps & impacts (subset of collision.ts SurfaceId)

export interface MapSource {
  id: 'depot';                                               // display name = t('map.' + id)
  cellSize: 2; width: 24; height: 18;
  grid: string[];                                            // 18 strings × 24 glyphs
  wallHeight: 3.0; ceilingY: 4.5; lintelY: 2.6;
  props: Record<'X' | 'c' | '~' | 'L', { height: number; inset: number; material: MaterialId; surface: SurfaceId; penetrable: boolean; penetrationFactor: number; kind: SolidKind }>;   // LOS is purely geometric (3D boxes), no 'low' flag
  platforms: { rect: CellRect; y: number; material: MaterialId; surface: SurfaceId }[];
  ramps: { cell: Cell; ascend: 'n' | 's' | 'e' | 'w'; from: number; to: number; steps: 4 }[];
  areas: { id: AreaId; rect: CellRect }[];                   // display names are i18n keys `area.<id>` (§11.13), owned by L4
  sites: { a: CellRect; b: CellRect };
  plantSpots: { a: Cell; b: Cell };
  spawns: { T: { cell: Cell; yawDeg: number }[]; CT: { cell: Cell; yawDeg: number }[] };   // index 0 = human slot
  holdSpots: { id: string; cell: Cell; yawDeg: number; team: 'T' | 'CT' | 'both'; crouch: boolean }[];
  chokes: { id: string; cell: Cell }[];
  materials: { wall: MaterialId; wallBase: MaterialId; floor: MaterialId; site: MaterialId; ceiling: MaterialId; door: MaterialId };
  training?: { sealed: CellRect[]; targets: Cell[]; onboardingCell: Cell };   // training-range variant of the SAME source (no second MapSource)
}
```

`compileMap(src, variant: 'match' | 'training' = 'match'): CompiledMap` (deterministic, unit-tested; `'training'` additionally emits one invisible `kind: 'seal'` solid (`f … 3.0 m`) per `training.sealed` rect and fills `CompiledMap.training`):

1. **Solids** — greedy merge of horizontal runs of identical `#` cells, then vertical merge of identical rows (Depot: ≈ 70 wall boxes instead of 190 cells); one box per prop cell (`X`, `c`, `~`, `L`), `c` inset 0.5 m; platform slabs; 4 stair boxes per ramp; door lintels; one ceiling slab. Each solid is a `SolidDef` (§11.16: the collision `Solid` fields `{ box, surface, penetrable, tag }` plus `penetrationFactor`, `kind: SolidKind` and `material: MaterialId | null`); `CompiledMap.solids[i]` and `StaticWorld` solid `id = i` line up one-to-one so `RayHit.solid.id` indexes `solids[]` and `renderHints.solids[]`. `kind: 'ramp-step'` solids are used by raycasts and LOS but are climbable by `moveBody` via step-up; `kind: 'seal'` solids have `material: null`. Floor 0 is the `StaticWorld` ground plane (`groundY: 0`, no floor slabs); platform tops are slabs. Expected total for Depot: **≈ 110 solids**.
2. **Floor function** — `floorY(x, z)` = platform height inside platform rects, else 0 (`StaticWorld.floorHeightAt` handles stairs/crates by probing solids).
3. **Walk grid** — 1 m sub-grid (48 × 36): a sub-cell is walkable if a standing body AABB (0.6 × 1.8 × 0.6) centred on it at the local floor overlaps no solid except ramp steps (whose tops are reachable by step-up); stores `floorY` per sub-cell and a `ramp` flag. **Ramp sub-cells** (the 4 sub-cells of a `=` cell) store the *wedge* height at their centre (linear from `from` to `to` along `ascend`, i.e. 0.375 / 1.125 m on Depot's ramps), not a stair-top height, and the nav builder connects them along the ascend axis regardless of Δfloor (§6.4). Depot: ≈ 1,150 walkable sub-cells → nav nodes.
4. **World-space data** — areas, sites, plant spots, spawns, hold spots, chokes converted to metres; `areaAt(x, z)`.
5. **Render hints** — `RenderHints` (exact shape in §11.16): per-solid material + `uvScale` (0.5 repeats per metre = 1 repeat per 2 m), floor quads, ramp wedges, door frames, lamp positions (one per 4 × 4 m of floor), site decal quads and wall signs, and the top-down wall segments used by the radar. The renderer and the radar consume only `renderHints`, never the grid.

Compiler assertions (tests): every row is 24 glyphs; every `T`/`C` count is 5; every cell in a platform rect is one of `^ A c X # =`-compatible glyphs; each ramp's `from` neighbour floor equals `from` and `to` neighbour equals `to`; every spawn sub-cell is walkable; BFS over the walk grid reaches both sites and the enemy spawn from each spawn; no two solids overlap; all solids lie inside bounds.

---

## 4. Weapons

### 4.1 Weapon table (metres, seconds, degrees; real CS names)

`Speed` = max move speed holding the weapon. `Spread` = cone half-angle (°) of the first shot: standing / moving at max speed / crouched. `Per-shot` = inaccuracy added per unit of heat (°); `Recover` = heat lost per second. `Falloff` = damage multiplier per 10 m. `AP` = armor penetration. `Pen` = may continue through penetrable props (factor).

| id | Name | Type | Price | Dmg body / head | RPM | Mag / reserve | Reload | Spread stand / move / crouch | Per-shot / recover | Pattern | Speed | Falloff | AP | Pen | Kill $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `knife` | 匕首 Knife | melee | 0 (always owned) | slash 40 / stab 65 (backstab stab ×3 = 195) — `dmg` = slash, `melee: { stab: 65, stabRpm: 60, backstabMult: 3 }` | slash 120 (0.5 s) / stab 60 (1.0 s) — `rpm` = slash | — | — | — | — | — | 5.0 | 1.0 (no falloff) | 0.85 | — | 1,500 |
| `glock` | Glock-18 | pistol, semi | 200 (T default) | 30 / 120 | 400 | 20 / 120 | 2.2 | 1.2 / 4.0 / 0.85 | 0.35 / 10 | `P_pistol` | 4.8 | 0.90 | 0.47 | no | 300 |
| `usp` | USP-S | pistol, semi | 200 (CT default) | 35 / 140 | 350 | 12 / 24 | 2.2 | 0.9 / 3.5 / 0.65 | 0.35 / 10 | `P_pistol` | 4.8 | 0.91 | 0.50 | no | 300 |
| `deagle` | 沙漠之鹰 Desert Eagle | pistol, semi | 700 | 53 / 212 | 267 | 7 / 35 | 2.2 | 1.0 / 5.0 / 0.7 | 2.5 / 5 | `P_deagle` | 4.6 | 0.87 | 0.93 | ×0.5 | 300 |
| `mp5` | MP5-SD | SMG, auto | 1,500 | 27 / 108 | 750 | 30 / 120 | 2.6 | 1.0 / 2.0 / 0.7 | 0.25 / 9 | `P_smg` | 4.7 | 0.85 | 0.62 | no | 600 |
| `ak47` | AK-47 | rifle, auto (T) | 2,700 | 36 / 144 | 600 | 30 / 90 | 2.5 | 0.8 / 5.5 / 0.55 | 0.45 / 6 | `P_ak` | 4.3 | 0.98 | 0.77 | ×0.6 | 300 |
| `m4a4` | M4A4 | rifle, auto (CT) | 3,100 | 33 / 132 | 666 | 30 / 90 | 3.1 | 0.6 / 5.0 / 0.45 | 0.35 / 7 | `P_m4` | 4.4 | 0.97 | 0.70 | ×0.6 | 300 |
| `awp` | AWP | sniper, bolt | 4,750 | 115 / 460 (legs 85 fixed) | 41 (1.46 s bolt) | 5 / 30 | 3.6 | unscoped 8.0 / 12 / 7; scoped 0.05 / 6.0 / 0.04 | 0 / — | `P_awp` | 4.0 (3.3 scoped) | 0.99 | 0.97 | ×0.6; through `X` ×0.4 | 100 |
| `he` | 高爆手雷 HE Grenade | throwable | 300 (max 1) | 98 at 0 m → 0 at 3.5 m, linear | 1 throw / s | 1 | — | — | — | — | 4.9 | — | 0.50 | — | 300 |
| `flash` | 闪光弹 Flashbang | throwable | 200 (max 2) | 0; blind ≤ 3.0 s | 1 throw / s | 1 each | — | — | — | — | 4.9 | — | — | — | — |

Gear: `kevlar` $650 (armor → 100), `kevlar_helmet` $1,000 (armor → 100 + helmet), **helmet upgrade $350** when armor > 0 and no helmet; rebuying Kevlar with armor < 100 costs $650 and refills. `defuse_kit` $400 (CT only, 1). `c4` is an **`ItemId`, not a `WeaponId`** (`WEAPONS` has exactly the 10 rows above; `ITEM_PRICES.c4 = 0`): it is never selectable, has no slot, and is used only through `PlayerState.hasBomb`, `items[].kind = 'bomb'` and the Use pill. Rifles are team-locked in the buy menu (`teams: ['T']` / `['CT']`); dropped rifles can be picked up by anyone.

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
- **Aim offset** (where bullets go; **stored in radians**, `applyRecoil` multiplies the degree pattern by `DEG`): `aimOffset += P[i] · DEG · (1 + N(0, 0.08))` (stream `fire`), then every tick `aimOffset *= exp(−DT / 0.45)`; clamped to pitch ≤ 12° · DEG, |yaw| ≤ 6° · DEG. With τ = 0.45 s an AK spray (0.1 s between shots) loses only 20 % per shot, so the steady-state climb is ≈ 9°: the player **must** drag down to keep hitting.
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

- **Trigger:** semi-auto fires once per press edge (the input layer latches a sub-tick tap into one `FIRE` tick); auto fires every `60 / RPM` s while held; `AWP`: shot → 1.46 s bolt → re-scope when `cfg.options.scopeHold` (human) / always (bots). Dry fire emits `dryFire`. **Auto-reload is not a sim rule:** for the human, `input/inputSystem.ts` sets `RELOAD` when `local.mag == 0 && local.reserve > 0` and `candidates.length == 0` for ≥ 48 consecutive ticks (setting 「自动换弹」, default on); bots reload through `ai/combat.ts` (§6.2).
- **Hitscan** (`weapons/hitscan.ts`): ray from eye along the shot direction, max 200 m, against (a) `StaticWorld.raycastAll` and (b) every alive enemy's hitboxes in the victim's yaw-local frame: head sphere r 0.16 at feet + 1.60 (crouched 1.10); torso box 0.5 × 0.6 × 0.3 at y 0.9–1.5 (chest = upper 55 %, stomach = lower 45 %); legs box 0.5 × 0.9 × 0.3 at y 0–0.9. Crouched: torso y 0.6–1.1, legs 0–0.6. Nearest `t` wins; teammates are skipped (friendly fire off). Emits `shot`, `hit`, `impact`, `nearMiss` (ray passes < 1.5 m from a player's head).
- **Knife:** sphere-cast r 0.3 m, reach 1.2 m, 60° cone; backstab when the angle between the victim's forward and attacker→victim is < 60°.
- **Grenades** (`weapons/grenade.ts`): sphere r 0.07; release speed **12 m/s** (tap) or **7 m/s "short toss"** at +10° above aim; gravity 20 m/s²; swept-sphere vs solids, restitution 0.45, friction 0.7, sub-stepped ×4 when speed > 10 m/s; players ignored. HE fuse 2.0 s, flash 1.5 s, both from release. **Throw protocol (`tickWeapon`):** `THROW` works from **any slot**. On the `THROW` rising edge with `inv[selectedGrenade] > 0` and `p.throwing == null`, the sim stores `p.throwing = { startTick: tick, returnSlot: inv.active }` and switches to slot 4 (0.25 s). On the falling edge (or at most 3 s later) the grenade is released at `max(releaseTick, inv.switchEndsTick)`: held < 18 ticks (300 ms) → 12 m/s, ≥ 18 ticks → 7 m/s. 30 ticks after release the sim switches back to `returnSlot` (or the best remaining slot); `p.throwing = null`. While `inv.active == 4`, a `FIRE` bit is treated as `THROW` (desktop LMB on slot 4). `SnapLocal.throwHoldT` (seconds held, −1 when idle) lets the renderer draw the preview dots.
- **HE damage:** `98 · max(0, 1 − dist / 3.5)` to every enemy whose chest **or** head has LOS from the burst centre; armor rule with AP 0.5; self-damage **on** (CS rule), teammates **off**.
- **Flash:** for each player (both teams) within 20 m with LOS: `blind = 3.0 · clamp(cos α, 0, 1)^0.7 · clamp(1 − dist / 20, 0.25, 1)` s (α = angle between view direction and direction to the flash). Human: white overlay alpha 1 → 0 over `blind` plus a 3.5 kHz ring; bots: perception disabled, 50 % spray toward the last known target direction.
- **World items** (`items[]`): death drops the primary weapon and the C4 (§11.6.1 death pipeline); the `DROP` bit (pause-menu 「丢弃武器」 via `input.press(Btn.DROP)`, desktop G) drops the active primary. Every tick the sim calls `tryPickup(state, p, auto, out)` for each alive player whose feet AABB overlaps an item: with `auto = true` (bots always; the human when `cfg.options.autoPickup`) an item that fills an **empty** matching slot or the bomb (T only) is taken immediately; otherwise the Use pill reads 「拾取 / Pick up」 and a `USE` press swaps (the held primary is dropped in place). Bots pick up a better gun within 6 m of their path and always retrieve a dropped bomb (§6.8).

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

Money is applied by `rules/economy.ts` in exactly two places: immediately for plant/defuse (`tickBomb`) and kill (`onKill`, called by the death pipeline §11.6.1), and once on entering `ROUND_END` for win/loss (`awardRoundEnd` returns a `MoneyDelta[]` that the HUD lists). Every change emits `money { player, delta, reason }`. All amounts clamp at $16,000.

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

---

## 6. Bot AI

### 6.1 Composition, profiles, difficulty matrix

Per match: human + 4 friendly bots vs 5 enemy bots (3v3: 2 + 3; 2v2: 1 + 2). Each bot has a `BotProfile { nameKey; difficulty; preferredWeapon: 'rifle' | 'smg' | 'awp'; aggression: 0.2–0.9; holdPreference: 0–1 }` (§11.4) produced by `makeProfiles(cfg)` (`ai/`) from `new Rng(cfg.seed).fork('profiles')` — a derived generator, **not** a sim stream, so profile sampling never shifts the sim's `spawn` stream (at most one `awp` per team). The boot sequence is in §11.6. Twelve name **keys** `bot.wang`, `bot.qiang`, `bot.lei`, `bot.fang`, `bot.hu`, `bot.lin`, `bot.song`, `bot.yu`, `bot.bao`, `bot.kai`, `bot.ming`, `bot.tao` live in `ai/names.ts` (`BOT_NAME_KEYS: string[]`); their zh/en strings ("老王 / Wang", "阿强 / Qiang", …) live only in `i18n/zh.ts` / `en.ts` (L4). When `profiles` is omitted (stubs, tests) `createMatch` uses `defaultProfiles(cfg)`: `nameKey = 'bot.' + BOT_NAME_KEYS[i]`, difficulty from the matrix below, `preferredWeapon: 'rifle'`, `aggression: 0.5`, `holdPreference: 0.5`.

| Match difficulty | Enemy bots | Friendly bots | Aim assist effect on bots |
|---|---|---|---|
| 新手 Easy | Easy | Normal | none |
| 普通 Normal | Normal | Normal | none |
| 困难 Hard | Hard | Hard | none |

Bots are never scaled by the player's assist/auto-fire settings; the stats screen records the settings used, and the hero feeling on Easy comes from the friendly bots being a tier better.

### 6.2 State machine (`ai/brain.ts`; `think()` is called **every tick** for every alive bot in ascending id order (steering, aim and trigger run every tick); the FSM decision + perception pass runs only on ticks with `tick % 6 == k % 6`, where **`k` = the bot's index in `state.bots[]`** (0-based, not the entity id); `teamThink(team, ctx)` is called once per team per tick before any `think()` (T first, then CT) and internally calls `planTeam()` on `roundPhase: FREEZE`, on `bombPlanted`, on carrier death and otherwise every 60 ticks)

```
DEAD ─round start─► BUY ─bought|no money─► PLAN ─goal assigned─► MOVE
MOVE ─enemy seen─► ENGAGE        MOVE ─heard & aggression>0.5─► INVESTIGATE
MOVE ─at hold goal─► HOLD        MOVE ─carrier at site & no enemy 1.5 s─► PLANT
MOVE ─CT at live bomb & no enemy 1 s (or bomb < 12 s)─► DEFUSE
HOLD ─enemy seen─► ENGAGE        HOLD ─timer U(8,25)·holdPref | objective changed─► PLAN
INVESTIGATE ─arrived, nothing─► PLAN   INVESTIGATE ─enemy seen─► ENGAGE
ENGAGE ─LOS lost > 2 s─► HUNT    ENGAGE ─hp < retreatHp & cover ≤ 10 m & not last alive─► RETREAT   ENGAGE ─target dead─► PLAN
HUNT ─enemy seen─► ENGAGE        HUNT ─last known pos reached─► PLAN
RETREAT ─at cover 2 s (reloaded)─► HOLD
PLANT ─3 s uninterrupted─► PLAN(post-plant spot)   PLANT ─enemy seen (per courage rule)─► ENGAGE
DEFUSE ─done─► (round ends)      DEFUSE ─enemy seen (per courage rule, never if bomb < 12 s)─► ENGAGE
any ─hp ≤ 0─► DEAD ;  TDM: DEAD ─respawn─► PLAN
```

| State | Behaviour |
|---|---|
| `BUY` | runs `buyPlan()` once during FREEZE (plus the team eco rule §6.7); no movement |
| `PLAN` | asks the team strategy (§6.5) for a goal `{ kind: 'site' | 'hold' | 'bomb' | 'investigate' | 'roam', pos, holdSpot? }`, computes an A* path |
| `MOVE` | follows the path (§6.4); looks along the path with a ±20° scan every 1–2 s; cautious bots (aggression < 0.4) stop 0.4 s at `chokepoint` nodes and peek; sprints otherwise |
| `HOLD` | at the hold spot: crouch if the spot says so, face its yaw, scan ±15° slowly; CTs holding a site stay until the bomb is planted elsewhere or round time < 30 s |
| `ENGAGE` | combat (§6.6); strafes/peeks per difficulty; reloads when the mag < 25 % and no enemy visible for 1 s; switches to pistol when the mag is empty and the enemy is < 6 m |
| `HUNT` | paths to the last known position, then PLAN |
| `RETREAT` | nearest cover node ≤ 10 m not visible from the threat; reload there |
| `PLANT` / `DEFUSE` | stand still, hold `USE`; interruption rules in §6.8 |

### 6.3 Perception (`ai/perception.ts`; per bot every 6 ticks ⇒ ≤ 2 full perception passes per tick)

| Sense | Rule |
|---|---|
| FOV | 120° horizontal, 90° vertical, cone test on the direction to each enemy's chest |
| Vision range | Easy 35 m, Normal 50 m, Hard 60 m |
| LOS | `StaticWorld.lineOfSight(eye, head)` **or** `(eye, chest)` against every solid (3D boxes give "see over low crates" for free); checks only the 3 nearest in-FOV enemies |
| Recognition | an enemy becomes `seen` after **continuous** visibility ≥ recognition delay (Easy 0.50 s, Normal 0.30 s, Hard 0.18 s), so quick peeks work; one deterministic delay, no per-check probability |
| Reaction | from `seen`, the bot may fire after `N(mean, 0.2 · mean)` (Easy 0.45 s, Normal 0.25 s, Hard 0.12 s), stream `ai` |
| Memory | last known position kept 6 s after LOS loss; shared to the team blackboard after 0.5 s (simulated callout) |
| Hearing | `sound` events (§11.5 emission table) carry `(pos, loudness m)`: rifle/SMG shot 40, AWP 60, pistol 30, running footstep 10, reload 8, plant 25, defuse 15, grenade bounce 15, HE/flash explosion 60, bomb explosion global (× hearing multiplier); delivered through `BotBrain.onEvent` after step 7 of the same tick (§11.6). A heard-only enemy enters the blackboard with **confidence 0.5**: bots turn toward it / investigate but never shoot at confidence < 1 |
| Blind | flash sets `blindUntilTick`: perception off; 50 % spray toward the last target direction, else retreat |

### 6.4 Navigation (`nav/navgraph.ts`, derived from `CompiledMap.walk`; nothing hand-placed except hold spots)

1. **Nodes** = walkable 1 m sub-cells (Depot ≈ 1,150), position = sub-cell centre at its floor height.
2. **Edges** = 8-neighbours if both walkable, |Δfloor| ≤ 0.6 m, and (for diagonals) both orthogonal neighbours walkable (no corner cutting). **Ramp rule:** if either sub-cell has the walk-grid `ramp` flag, the orthogonal edge along the ramp's `ascend` axis is always created (the wedge heights 0 → 0.375 → 1.125 → 1.5 would otherwise fail the 0.6 m test); diagonal edges into or out of ramp sub-cells are never created. Cost = length × (1.4 if either node is within 0.5 m of a solid ≥ 1 m tall) — keeps bots off walls and crate corners.
3. **Tags**: `area` id; `chokepoint` (corridor width ≤ 2 m via a distance transform) plus the map's listed chokes; `coverScore` (how many of 8 directions hit a solid ≥ 1.0 m within 1.2 m) and `coverHeight` (1.0 low / 1.2 half / ≥ 2 full); `site`, `spawnT`, `spawnCT`.
4. **Hold spots** come from `map.holdSpots` (authored, §3.2) snapped to the nearest node; `coverNear(p, threat, r)` = cover node within `r` whose segment to `threat` is blocked (used by RETREAT and ENGAGE).
5. **A\*** with a binary heap and octile heuristic; typical query < 0.3 ms; `findPath(from, to, blocked?)` returns **node ids** (`number[]`, first = `nearest(from)`, last = `nearest(to)`), cached per round in an LRU of 512 `(fromNode, toNode)` pairs and cleared by `sim.ts` calling `nav.clearCache()` on every `roundPhase: FREEZE`. **String-pulling** is a separate `pullString(ids): Vec3[]`: skip nodes while `lineOfSight` (body expanded by 0.35 m, at knee height 0.5 m) is clear, leaving 3–8 corners; the brain stores both (`mem.path` = ids for blocked-node re-plans and the debug dump, `mem.corners` = the pulled waypoints that steering follows).
6. **Steering**: seek the next corner, arrive radius 0.5 m, teammate separation 1.0 m (side-step), then the bot emits an `InputCommand` consumed by the **same** `movePlayer()` as the human — bots cannot cheat physics.
7. **Stuck detector**: displacement < 0.3 m over 1 s while a path exists → jump once; still stuck 1 s later → mark the current node blocked for 5 s and re-plan.

Tests: node count within ±5 % of 1,150; every spawn reaches both sites; A → B path 31 ± 4 m; T spawn → A 44 ± 5 m; CT spawn → A 14 ± 3 m; no path segment intersects a solid; cover nodes exist behind each `~`, `c`, `X`; 500 random queries average < 1 ms.

### 6.5 Team strategy & blackboard (`ai/strategy.ts`; plain data in `WorldState.teams[team]`)

`Blackboard { lastEnemySeen: { id, pos, tick, confidence, by }[]; bombPos?: Vec3; plannedSite?: 'a' | 'b'; assignments: Record<EntityId, Goal>; rotateCalledTick?: number }`.

- **T:** at round start pick a site (A 55 % / B 45 %; 30 % chance to flip after a lost round), stream `ai`. Main group = carrier + (n − 2) attackers via the shortest lane; one **lurker** (highest aggression) takes the other lane and holds its connector (`lurk_*_connector`) until the first contact event, then joins. Rush timing: Easy waits 10 s at the spawn exit, Normal 4 s, Hard goes immediately. Carrier death → nearest T gets goal `bomb`.
- **CT:** default split 2 A / 2 B / 1 mid (3v3: 1/1/1; 2v2: 1/1) on hold spots; on `bombPlanted` or any confidence-1 sighting at a site, every CT not in ENGAGE rotates there (Easy never rotates); after 45 s of LIVE without contact CTs push toward T spawn through mid.
- Bots never telegraph: intent is visible only via radar dots of teammates.

### 6.6 Combat behaviour (`ai/combat.ts`)

```
desired  = (rng < p_head ? head : chest) of target
error    = Gaussian2D(σ_err) in the plane ⟂ to view, re-sampled every τ_err s, scaled by (1 + 2 · targetSpeed / 4.3) · (1 + 0.4 · dist / 20)
aimDir  ← slerp toward dir(desired + error) with rate 1 − exp(−DT / τ_track), capped at turnRate
fire when angle(aimDir, target chest) < fireCone AND LOS AND reaction elapsed
```
Bots fire through the same weapon code (spread, recoil, falloff). Recoil control: each tick `look.pitch −= recoilControl · 0.5 · aimOffset.pitch`. Bursts: automatic weapons fire `burst` shots then pause; AWP: scope → wait for aim < 0.5° → shoot → unscope. Pistols tap at 70 % RPM. Knife only when out of ammo and dist < 3 m. Strafe/peek per difficulty; cautious bots lean out of a cover node (0.6 m out, burst, back). Grenades (Normal+): HE at a heard-but-unseen group ≥ 2 within 15 m or at the attacked site; flash (Hard) before entering a chokepoint whose far side has a known enemy within 12 m.

### 6.7 Difficulty table & buying

| Parameter | 新手 Easy | 普通 Normal | 困难 Hard |
|---|---|---|---|
| Recognition / reaction | 0.50 / 0.45 s | 0.30 / 0.25 s | 0.18 / 0.12 s |
| σ_err (° at 10 m) | 3.5 | 1.8 | 0.8 |
| τ_err / τ_track | 0.6 / 0.35 s | 0.5 / 0.2 s | 0.4 / 0.1 s |
| Turn rate cap | 180°/s | 360°/s | 720°/s |
| Fire cone | 5° | 3° | 1.8° |
| p_head | 0.05 | 0.20 | 0.45 |
| Burst length / pause (auto) | 3–5 / 0.5 s | 5–8 / 0.3 s | 8–14 / 0.2 s |
| Recoil control | 0.3 | 0.6 | 0.9 |
| Strafe | none | 35 % strafe-peek 1.5 m | counter-strafe + crouch 40 % |
| Vision range / hearing mult | 35 m / 0.6 | 50 m / 1.0 | 60 m / 1.2 |
| Retreat HP | 50 | 35 | 25 (never in a 1v1) |
| Plant/defuse courage | abort if any enemy seen | abort if enemy < 10 m | continue if a teammate covers |
| Grenades | none | HE | HE + flash |
| Rotates on info / fake defuse | no / — | yes / — | yes / 25 % |

Buying: `buyPlan()` (§5.2) with `prefs.sniper = preferredWeapon == 'awp'`; team eco rule: if the team's average money < $2,000 and nobody can afford a rifle, all bots buy nothing (coordinated save) unless `teamLossStreak ≥ 2`, in which case they buy Kevlar + Deagle where affordable.

### 6.8 Bomb behaviour

- **Plant:** the carrier plants at the site's plant spot (§3.2) once a teammate is within 10 m or 20 s of LIVE have passed; interrupted by taking > 20 damage (Easy/Normal) or by the courage rule. After the plant, Ts take `postplant_*` spots facing the entrances; the lurker holds the connector.
- **Defuse:** the nearest alive CT with LOS to the bomb and no visible enemy defuses (kit holder preferred); other CTs `HOLD` entrance-facing spots. **Ninja/hero rule:** with < 12 s left and the bomb reachable, a CT defuses regardless of visible enemies. Hard CTs fake-defuse 25 % (1 s start, stop, re-check).
- **Dropped bomb:** the nearest T retrieves it; Hard CTs camp a dropped bomb from a cover node 6 m away.
- CTs learn the bomb position from the `bombPlanted` event (everyone hears the plant).

### 6.9 Bot memory is data

`WorldState.bots[]` holds one `BotMemory` per bot with exactly the fields listed in §11.4 (`profile`, FSM state, goal, `path` ids + `corners`, target timers, aim error and `aimYaw/aimPitch`, burst/pause/hold timers, stuck detector, `peek`; **`blindUntilTick` lives on `PlayerState`** because the human is blinded too) — all numbers/plain objects, so `serialize()`/`structuredClone` capture bots exactly and `restore()` then stepping equals continuous play. The brain instance itself is stateless: `BotBrainFactory(difficulty)` returns **one shared instance per difficulty** (3 at most); everything per-bot is in `BotMemory`.

---

## 7. Controls

### 7.1 Reference device & safe area

Design target: 6.1–6.7" phone, landscape, CSS viewport **851 × 393** (Pixel 5) up to 932 × 430, DPR 2–3. Positions are `(x % of viewport width, y % of viewport height)`; sizes in **vh** (1 vh = 1 % of height) so buttons scale with physical height. The UI root is inset by `env(safe-area-inset-*)` and by `--cutout-left/right` CSS variables posted by the Android bridge. Thumb model: comfortable arc ≈ 35 % of width from each bottom corner, 60 % of height. The whole touch layer has scale (80–120 %) and opacity (30–100 %) settings and a drag editor (§8.5); 「左手模式 / Left-handed」 mirrors every x.

### 7.2 Touch layout ("Classic", default) and pointer ownership

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [HP][AP]       [timer 1:05] [T 3:2 CT]      [kill feed]  [‖]   [radar]   │ 0–25 %: HUD, inert on the left
│ [$ 4,250]                                                                │
│ (floating joystick zone x<45 %, y>25 %)   ╎  (look zone)      [ammo]      │
│  [Fire-L]                                 ╎   [⌖]   [跳]                 │
│         ◎ joystick                        ╎ [切枪] [换弹]     (Fire-R)    │
│                                           ╎         [蹲]                 │
│ [购买]                      [安放/拆除/拾取] [雷]                           │
└──────────────────────────────────────────────────────────────────────────┘
```

| Control | Centre (x %, y %) | Size | Behaviour |
|---|---|---|---|
| **Move joystick** (floating) | zone x 0–45 %, y 25–100 %; ring appears where the thumb lands | ring ⌀ 24 vh, knob ⌀ 10 vh, max travel 8 vh, dead zone 12 % | direction → `(moveX, moveZ)` unit vector; magnitude is quantised: travel < 12 % → `|move| = 0`; 12–75 % → `|move| = 0.6` (walk band, §7.8 rule ⇒ 0.52× speed, silent); > 75 % → `|move| = 1` (run); the joystick pointer never contributes look |
| **Look (drag)** | any pointer not owned by a button, outside the joystick zone and the inert top-left band | — | Δpx → yaw/pitch (§7.4); every look-owning pointer's delta is summed |
| **Fire-R** | (90, 72) | ⌀ 18 vh; hit margin 3 vh, extended to the screen edge | hold to fire; **fire + look**: dragging this pointer also rotates the view (track while spraying) |
| **Fire-L** | (8, 46) | ⌀ 13 vh, margin 3 vh | identical to Fire-R; lets the right thumb keep aiming ("three-finger") |
| Jump 跳 | (78, 58) | ⌀ 10 vh | tap |
| Crouch 蹲 | (78, 86) | ⌀ 10 vh | toggle (setting: hold) |
| Reload 换弹 | (69, 72) | ⌀ 9 vh | tap; always present |
| Switch 切枪 | (69, 56) | ⌀ 9 vh | tap cycles primary → pistol → knife; icon shows the next weapon |
| Scope ⌖ (AWP only) | (78, 44) | ⌀ 9 vh | tap: 1× → 2× → unscoped |
| Grenade 雷 | (69, 88) | ⌀ 9 vh | tap = full throw of the selected grenade; hold ≥ 300 ms = short toss (7 m/s); preview dots while held |
| Grenade select chip | (60, 76) | ⌀ 7 vh, visible only when both HE and flash are owned | tap swaps the selected grenade; icon = the other one |
| **Use pill** 安放 / 拆除 / 拾取 | (57, 90) | 16 % × 8 vh, contextual | hold: plant (T in site with C4), defuse (CT within 1.5 m of the bomb), pick up (item under foot / dropped bomb); weapon is lowered while held |
| Buy pill 购买 | (10, 92) | 18 % × 8 vh, buy window only, pulses | opens the buy menu |
| Pause ‖ | (84, 6) | ⌀ 7 vh | pause menu (sim pauses) |
| Scoreboard | tap the score at (50, 8) | — | hold to show |

**Pointer ownership (`input/touch.ts`).** On `pointerdown`, hit-test in this order and give the pointer to the first match for its whole lifetime: (1) buttons and pills including their hit margins (on overlapping margins the nearest centre wins); (2) the joystick zone; (3) the look zone. Fire-R/Fire-L are *fire + look* controls; all other buttons consume their pointer entirely. Buttons report `held` per frame; the input layer latches a press that starts and ends between two ticks into one tick with the bit set, so a 10 ms tap never drops a shot. `touch-action: none`, `{ passive: false }` listeners, `pointerrawupdate` when available.

Non-overlap check at 851 × 393 (hit discs incl. 3 vh margins): Fire-R spans x 85.9–94.1 %, y 60–84 %; Jump 75.7–80.3 / 50–66; Crouch 75.7–80.3 / 78–94; Reload 66.9–71.1 / 64.5–79.5; Switch 66.9–71.1 / 48.5–63.5; Grenade 66.9–71.1 / 80.5–95.5; Use pill 49–65 / 83–97; Scope 75.7–80.3 / 36.5–51.5 — no disc overlaps another except margins (resolved by nearest centre). The ammo counter (90, 52) lies above Fire-R's margin (top 60 %).

### 7.3 Gestures

| Gesture | Action |
|---|---|
| Quick tap in the look zone (< 150 ms, < 8 px) | **tap-to-fire** one shot (setting 「点击开火」, default on) |
| Double-tap in the look zone | jump (setting, default off) |
| Two-finger tap in the look zone | reload (setting, default off) |
| Pinch in the look zone | AWP zoom toggle (alternative) |
| Spectating: swipe left/right | `InputCommand.spectate = −1 / +1` for one tick (§2.2) |

No hidden gestures on HUD elements (drop weapon is in the pause menu).

### 7.4 Sensitivity, acceleration, gyro

- `yawΔ = Δpx · 0.022° · sens · (fov / 75)`, `pitchΔ = 0.85 · that`, `sens` 1–20 (default **8** → 0.176 °/px → a full-width 851 px swipe ≈ 150°). CSS px are DPR-normalised so different phones feel the same. Separate `sensScoped` (default = sens, auto-scaled by FOV).
- **Acceleration** (「灵敏度加速」, default on): `factor = 1 + 0.6 · clamp((v − 400) / 800, 0, 1)`, `v` in CSS px/s.
- **Sampling:** raw deltas accumulate between ticks and are consumed by the tick; the render frame additionally previews the not-yet-consumed delta on the camera (§11.6), so look latency is one frame, not one tick.
- **Gyro** (「陀螺仪」: 关 / 拖动时 / 始终, default off): the Generic Sensor `Gyroscope` (60 Hz) with a `deviceorientation` fallback, in browsers **and** in the WebView (the `appassets.androidplatform.net` origin is secure, so no bridge method is needed); `yaw += rate.y · gyroSens · dt`, `pitch += rate.x · gyroSens · dt`; recentred on release of the look pointer; hidden when neither API exists.

### 7.5 Aim assist & auto-fire (`input/aimAssist.ts`, pure; defaults: 辅助瞄准 = 中, 自动开火 = 关)

Candidates come from the sim each tick: `sim.aimCandidates()` → `AimCandidate { id, chest: Vec3, radius: 0.35, vel }[]` (type owned by `sim/state.ts`, computed in `sim/candidates.ts`) for enemies with LOS from the human's eye within 40 m and in front of the camera; the human's eye position is `local.eyeX/eyeY/eyeZ` in the snapshot. `applyAimAssist(delta, look, eye, candidates, level, dt, dragging, strafing)` returns the modified delta and is called **both** at tick time and for the render-frame preview (same candidates, same function) so friction never "snaps". Crouch 「切换 / 按住」 is implemented entirely in the input layer (toggle keeps the `CROUCH` bit set until the next tap).

| Level | Friction (multiply the delta) | Magnetism (added rotation toward the chest centre) |
|---|---|---|
| 关 Off | — | — |
| 低 Low | × 0.75 while the crosshair is within 2.0° of a body | — |
| 中 Medium | × 0.60 within 2.5° | ≤ 1.5°/s while **dragging** (|Δpx| > 0) and within 4° |
| 高 High | × 0.50 within 3.0° | ≤ 3°/s within 5°, while dragging **or strafing**; compensates 60 % of the target's angular velocity |

Body only, never the head; never applied to bots.

**Auto-fire** (「自动开火」): the sim writes `snapshot.local.crosshairTarget` (0 none / 1 enemy / 2 friend) from a ray along `look + aimOffset`; when enabled and the target is an enemy for ≥ 6 consecutive ticks, the input layer sets `FIRE` (semi-autos are pulsed at 70 % of max RPM); disabled for the knife and unscoped AWP. The crosshair turns red on an enemy whenever assist or auto-fire is on, amber on a teammate.

### 7.6 Onboarding (first launch)

1. Orientation gate: in portrait, a full-screen 「请横屏 / Rotate your phone」 card with an animated phone (also on every later launch).
2. Training range, 3 steps ≈ 60 s: **移动 / Move** (reach a marked cell; joystick overlay fades), **瞄准与射击 / Aim & fire** (hit 5 targets; teaches drag + Fire-R + tap-to-fire), **购买 / Buy** (buy an AK with 「全装」). Each step ends with a haptic + toast.
3. One-line aim-assist choice (Low / Medium / High). Persists `onboarding.done = true`.

### 7.7 Desktop fallback (dev, tests, laptops)

WASD move, Shift walk (`WALK` bit), Ctrl crouch (hold), Space jump, R reload, Q last weapon, 1/2/3/4 slots (4 = grenade, press again to swap HE/flash), G drop (`DROP`), E use (plant/defuse/pickup), B buy, Tab scoreboard (hold), Esc pause, ← / → cycle spectate target, F1 debug overlay; mouse look via Pointer Lock on canvas click at `0.022° · sens / 8` per px, LMB fire (= `THROW` while slot 4 is active, held ≥ 300 ms = short toss), RMB scope, wheel cycles weapons. The touch layer auto-hides when `(pointer: fine)` matches and re-shows on the first touch.

### 7.8 `InputCommand` — the only thing the sim reads from input

```ts
export const enum Btn { FIRE = 1, SCOPE = 2, JUMP = 4, CROUCH = 8, RELOAD = 16, USE = 32, WALK = 64, DROP = 128, THROW = 256 }
export interface InputCommand {
  tick: number;
  moveX: number; moveZ: number;      // body-local, |(moveX, moveZ)| ≤ 1; +Z forward, +X right
  yaw: number; pitch: number;        // ABSOLUTE view angles (radians); the input layer accumulates deltas, sens, accel, gyro and aim assist
  buttons: number;                   // Btn bitfield, latched per tick
  slot: 0 | 1 | 2 | 3 | 4;           // 0 = no change; 1 primary, 2 pistol, 3 knife, 4 grenade
  grenade: 0 | 1 | 2;                // 0 keep, 1 HE, 2 flash (selection; mirrors Inventory.selectedGrenade 'he' | 'flash')
  buy: ItemId | null;                // processed by rules/economy.ts if allowed
  spectate: -1 | 0 | 1;              // dead players only: cycle the spectated teammate (§2.2)
}
export const IDLE_COMMAND: Readonly<InputCommand>;   // tick 0, zero move, yaw/pitch 0, no buttons; cloned by stubs and freezeBots
```
**One movement rule (`world/movement.ts`):** `len = |(moveX, moveZ)|`; `len < 1e-3` ⇒ stop; `walk = (buttons & WALK) != 0 || len ≤ 0.75`; target speed = `maxSpeed · (walk ? 0.52 : 1) · (crouched ? 0.5 : 1)` along the normalised direction — the magnitude is binary, never proportional. Bots produce the same struct; nothing in the sim knows whether a command came from touch, keyboard or a brain. UI-originated actions reach the next command through `InputSystem.press(btn)` (one-tick latch: `DROP`, `RELOAD`, …), `InputSystem.setBuy(item)` and `InputSystem.spectate(dir)`; `skipRound`, pause and quit are app actions, not commands.

---

## 8. HUD & menus

All UI is **DOM over the canvas** (`#ui` above `#gl`), system font stack `system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Roboto, sans-serif`, `font-variant-numeric: tabular-nums`, minimum 14 CSS px, 1 px dark text outline. Colours: own team `#4FC3F7`, enemy `#FF7043`, T accent `#E0A23A`, CT accent `#4F8FD6`, warning `#FFD54F`, danger `#E04545`, text `#F5F5F5`. The HUD reads a `HudState` built from the `RenderSnapshot` at **20 Hz** and touches the DOM only when a value changed; events (kill feed, notices, hit marker) are applied as they are drained. Every interactive element carries `data-testid`.

### 8.1 In-game HUD elements (positions as in §7.2; `vh` sizes)

| Element | Position / size | Content & behaviour |
|---|---|---|
| Health + armor | top-left (2 %, 4 %), 22 vh wide; bars 2.4 vh + numbers 18 px | HP bar red→green, pulses < 30; armor bar blue with a helmet glyph when `helmet` |
| Money | under HP (2 %, 14 %), 16 px `$ 4,250` | floating `+$300` / `−$2,700` deltas for 1.5 s |
| Bomb / kit indicator | right of money | C4 or kit glyph |
| Round timer | top-centre (50 %, 3 %), 22 px bold | amber at 15 s; when planted: red bomb glyph + 35 s countdown bar instead of digits; buy window shows 「购买 0:12」 beneath during FREEZE/first 10 s |
| Score & alive pips | (50 %, 8 %), 14 px `T 3 : 2 CT` + 5 pips per team | tap/hold → scoreboard |
| Kill feed | (56–80 %, 14–30 %), 4 rows × 13 px, 5 s each | `老王 [AK] 你`, headshot glyph; `pointer-events: none` |
| Radar | top-right (98 %, 4 %) anchor, 24 vh square, 2D canvas | rotates with the player, 18 m radius, 2 px/m; walls from `renderHints.radarWalls`, self arrow, teammates blue, enemies red for 3 s after a `spotted` event for the human's team (the app keeps `Spotted[]` from the events and passes it to `Radar.draw`), bomb, site letters |
| Crosshair | centre, 4 lines; `gap_px = 4 + spreadDeg × 12`; drawn at the projection of `look + aimOffset` (§4.3): since the camera is `look + 0.5·aimOffset`, the screen offset is `dx = tan(0.5·aimOffsetYaw) / tan(fov/2) · H/2 · aspect⁻¹`, `dy = −tan(0.5·aimOffsetPitch) / tan(fov/2) · H/2` with `fov`/`H`/`aspect` from `Hud.setView()` (no preview needed) | white; red on enemy / amber on teammate when assist or auto-fire is on; hit marker ✕ 80 ms, red on kill |
| Ammo | (90 %, 52 %): `24 / 90` 20 px + weapon icon 10 vh | amber ≤ 25 %, red at 0 with 「换弹!」 |
| Weapon strip | hidden; shows 1.5 s on switch: 3 icons + grenade count | |
| Centre notice | (50 %, 28 %), 24 px | 「炸弹已安放 / Bomb planted」, round banners, 「+$300」 2 s |
| Plant/defuse ring | around the crosshair, 8 vh | progress; 「安放中… / Planting…」 |
| Damage direction | 4 red arcs at the screen edge | 0.5 s toward the last damage source |
| Low-HP vignette / flash overlay | full screen | red edge `(30 − hp) / 30`; white overlay alpha 1 → 0 over the blind duration |
| Spectator bar | bottom-centre | 「观战: 阿强 ◁ ▷」 + 「跳过回合 ⏩」 (timeScale 4) |
| Debug overlay | top-left, `?debug=1` or F1 / 5 taps on the timer | fps, frame ms avg/p95, sim ms, bot ms, draw calls, tris, heap, bot states |

### 8.2 Main menu (主菜单)

Left 40 %: a live render of a bot walking the map under a cinematic camera (renderer only, no sim). Right 60 %: title, 12 vh-tall full-width buttons **开始游戏 / Play**, **训练场 / Training**, **设置 / Settings**, **战绩 / Stats**, a `中 / EN` pill top-right, version + 「离线可用 / Offline ready」 badge at the bottom, and a 「继续上次比赛 / Continue」 tile when `cs.v1.match` exists. On the main menu only, a 「有新版本 / Update」 toast appears when a new service worker is waiting.

### 8.3 Mode select (模式)

Three cards: 爆破 (5v5, ≈ 10 min), 死斗 (4 min), 训练. Below: difficulty segmented control (新手 / 普通 / 困难), team (T / CT / 随机), team size (2v2 / 3v3 / 5v5), rounds to win (4 / 6 / 8). 「开始 / Start」 bottom-right (thumb).

### 8.4 Buy menu (购买)

Overlay over 90 % of the screen; the sim keeps running and the timer stays visible. Top row: 5 quick-buy tiles (§5.1) with price and 「可负担 / 钱不够」; below: the 4 columns of §5.1 as 14 vh × 18 vh tiles (icon drawn with Canvas paths, name, price, owned ✓, team lock). Money top-right; 「关闭 ✕」 bottom-right. One tap buys and auto-equips; the menu closes unless 「连续购买」 is on; closes automatically when the buy window ends; 「钱不够 / Not enough money」 toast + denied sound on failure.

### 8.5 Settings (设置) — tabs 控制 / 画面 / 声音 / 语言与其他

| Setting | Options | Default |
|---|---|---|
| 灵敏度 / 开镜灵敏度 | 1–20 | 8 / 8 |
| 灵敏度加速 | on / off | on |
| 辅助瞄准 | 关 / 低 / 中 / 高 | 中 |
| 自动开火 / 点击开火 | on / off | off / on |
| 动态准星 (recoil crosshair) | on / off | on |
| 陀螺仪 + 陀螺仪灵敏度 | 关 / 拖动时 / 始终; 0.5–2.0 | 关 / 1.0 |
| 蹲 | 切换 / 按住 | 切换 |
| 自动换弹 / 自动购买 / 自动拾取 / 开镜保持 | on / off | on / off / on / on |
| 自定义布局 | drag editor (every control, snap 1 %), scale 80–120 %, opacity 30–100 %, 「重置」 | — |
| 左手模式 | on / off | off |
| 画质 | 低 / 中 / 高 / 自动 | 自动 |
| 帧率 / 省电模式 | 30 / 60 / 不限; on → 30 fps + Low | 60 / off |
| 视野 FOV | 65–90 | 75 |
| 震动 | on / off | on |
| 主音量 / 效果 / 界面 | 0–100 | 80 / 100 / 70 |
| 语言 | 中文 / English | by `navigator.language` |
| 重置数据 | button with confirm | |

### 8.6 Pause (暂停) · 8.7 Scoreboard · 8.8 Round / match end

- **Pause:** true pause (`loop.pause(true)` / `loop.pause(false)`); buttons 继续, 设置, 购买 (if in the buy window), 丢弃武器 / Drop (UI action `drop` → `input.press(Btn.DROP)` on resume), 退出到主菜单 (confirm). Android back → pause / resume; backgrounding auto-pauses. Every menu button emits `bus.emit('action', { id })` on the injected `EventBus<UiEvents>` with the `UiAction` ids of §11.16; `app/game.ts` is the only subscriber that touches the sim, loop or input.
- **Scoreboard:** two team tables (`SnapPlayer.nameKey/kills/deaths/money` — money shown for the own team only, alive, bomb/kit glyph), round score, last-round MVP; shown automatically for the 3.25 s scoreboard part of ROUND_END (§2.1).
- **Round end:** banner 「T 胜利 — 炸弹已爆炸 / T win — bomb exploded」 in the team colour, kill-cam at 0.5× for 1.5 s, money delta list.
- **Match end:** 「胜利 / 失败 / 平局」, final score, MVP, personal K/D, HS %, accuracy, damage; buttons **再来一局 / Rematch** (same settings, seed + 1), **换模式 / Change mode**, **主菜单 / Menu**; lifetime stats updated.
- **Stats (战绩):** matches, wins, draws, K/D, HS %, favourite weapon, best streak, assist level distribution.

---

## 9. Audio (all WebAudio; buffers rendered offline at startup, no files)

### 9.1 Building blocks (`audio/dsp.ts`, exists; pure functions over `Float32Array` so they are unit-testable in Node)

The building blocks are the **existing, tested `src/audio/dsp.ts`** (kept as is): `whiteNoise(seconds, rng)`, `pinkNoise(seconds, rng)`, `oscillator(seconds, freq | (t) => freq, wave)`, `adsr(buf, a, d, s, r)`, `expDecay(buf, tau)`, `biquad(buf, 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'notch', fc, Q, gainDb)`, `softClip(buf, drive)`, `mix([{ buf, at, gain }])`, `echo(buf, delaySec, feedback, wet)`, `gain`, `normalize`, `fadeIn/Out`, `silence`. The shorthand used in the recipe table below maps onto them as: *noise* = `whiteNoise`/`pinkNoise` (brown = `pinkNoise` + `biquad lowpass 200 Hz`), *tone f1→f2* = `oscillator` with a frequency function, *env* = `adsr`, *lp/hp/bp* = `biquad`, *distort* = `softClip`, *layer/+* = `mix`, *delayCopy* = `echo`. `audio/recipes.ts` lists every sound as a function `(rng) => Float32Array` at 44.1 kHz mono; `audio/bank.ts` renders seeded variants into `AudioBuffer`s at startup: 2 variants for shots, footsteps, impacts and hits, 1 for everything else (≈ 45 ids, **≈ 70 buffers, ≈ 2.3 MB**); `ambient_hum` is a single **2 s** loop rendered at 22.05 kHz (≈ 90 KB, the context resamples) instead of 8 s at 44.1 kHz. ≈ 150 ms on the reference phone, shown on the loading screen. Texture and audio seeds are the constant `1337` (not the match seed) so startup output is stable.

### 9.2 Sound list (durations in ms; gain is the voice gain before the bus)

| Id | Recipe | Gain |
|---|---|---|
| `fire_glock` / `fire_usp` | noise 60 lp 4 kHz + tone 180→60 Hz 40 + 1 ms click; env A1 D50; USP adds lp 1.8 kHz (suppressed) | 0.8 / 0.5 |
| `fire_deagle` | noise 110 lp 2.5 kHz + tone 120→40 Hz 80, distort 0.6, brown tail 250 | 1.0 |
| `fire_mp5` | noise 45 bp 3 kHz Q1 + tone 220→90 Hz 25, lp 2 kHz (suppressed) | 0.55 |
| `fire_ak` | noise 90 lp 3 kHz + tone 150→55 Hz 60 + distort 0.5 + brown tail 200 | 0.9 |
| `fire_m4` | noise 70 bp 2.2 kHz + tone 200→70 Hz 50 + tail 150 | 0.85 |
| `fire_awp` | noise 180 lp 1.5 kHz + tone 90→30 Hz 150, distort 0.8, brown tail 600 lp 800 Hz, delayCopy 80 ms × 0.35 ("crack") | 1.0 |
| `fire_distant_*` | the same buffers through lp 600 Hz; chosen by the spatialiser when > 25 m | — |
| `knife_swing` / `knife_hit` / `knife_stab` | pink 120 bp 1.2 kHz sweep up / noise 40 + tone 400→200 Hz / + 80 ms lp 300 Hz thump | 0.5 / 0.7 / 0.7 |
| `reload_out` / `reload_in` / `reload_bolt` | 3 metallic clicks (tone 2.4 kHz 8 + noise 15 hp 3 kHz) 40 ms apart; `in` + 60 Hz thump; `bolt` = slide noise 150 bp 900 Hz + click | 0.6 |
| `switch_weapon` / `dryfire` | click 12 + cloth noise 80 lp 2 kHz / click 5 tone 1.8 kHz | 0.4 / 0.5 |
| `footstep_concrete` ×4 / `footstep_metal` / `footstep_wood` | noise 60 lp 900 Hz + tone 90 Hz 30, pitch ±10 % / noise 50 bp 1.8 kHz Q3 + ring 320 Hz 200 / lp 500 + tone 180 Hz 40 | 0.35 (walk 0.15, crouch 0) |
| `jump` / `land` | cloth noise 80 lp 400 / footstep × 1.5 + 50 Hz thump 80 | 0.4 / 0.5 |
| `hit_body` / `hit_head` / `hit_armor` | brown 70 lp 500 Hz + tone 110→60 / + tink 2.6 kHz 60 (helmet) or wet bp 1 kHz / tone 900 Hz 40 ring + noise 20 | 0.7 / 0.8 / 0.6 |
| `hitmarker` / `headshot_ding` | square 1.4 kHz 15 / sine 1.8 kHz 100 + 2.7 kHz 80 | 0.3 / 0.5 |
| `impact_concrete` / `impact_wood` / `impact_metal` / `impact_sand` | noise 40 bp 2.5 kHz + grit 120 / noise 50 lp 1.2 kHz + 180 Hz knock / tones 1.4 + 2.1 kHz ring 250 + noise 15 / noise 60 lp 700 Hz | 0.5 |
| `bullet_whiz` | bp noise 2.5→1.2 kHz sweep 120 | 0.4 |
| `death` | tone 180→90 Hz 200 lp 1 kHz distort + body thud 300 | 0.7 |
| `he_pin` / `he_bounce` / `he_explode` | click + 1.6 kHz ring / `impact_metal` × 0.5 / brown 700 lp 300→80 Hz distort 0.9 + crackle impulses 300 + ear ring 3.5 kHz 2 s if < 4 m | 1.0 |
| `flash_explode` / `flash_ring` | noise 200 hp 2 kHz + sine 2.4 kHz 150 / sine 4 kHz for the blind duration, fading | 1.0 / 0.15 |
| `bomb_beep` | square 2.5 kHz 40; interval `1.0 · (remaining / 35)^1.6 + 0.05` s | 0.5 |
| `bomb_plant` / `bomb_defuse_tick` / `bomb_defused` | 4 beeps 1.2 kHz + servo noise / 3 Hz ticking / descending 3-tone chime | 0.6 |
| `bomb_explode` | `he_explode` × 1.6, 1.6 s, + 20 Hz sub; global (no attenuation); master lp "deafened" 2 s | 1.0 |
| `round_start` / `round_win` / `round_lose` | square 660 / 880 Hz 120 each / triangle C-E-G 150 each / G-E♭-C | 0.5 / 0.6 / 0.6 |
| `buy` / `buy_denied` / `ui_tap` / `ui_back` | 1.2 + 1.8 kHz 60 / square 200 Hz 120 / click 3 kHz 10 / 1.5 kHz 10 | 0.5 / 0.5 / 0.3 / 0.3 |
| `radio_spotted` / `radio_bomb` / `radio_rotate` | 3 formant-swept bp noise blips 400→1,200 Hz 90 each (stand-ins for voice lines) | 0.4 |
| `ambient_hum` | looping brown noise lp 120 Hz + 50 Hz hum, 2 s at 22.05 kHz, 1 variant, cross-faded | 0.12 |

### 9.3 Spatialisation & mixing (`audio/engine.ts`)

- `AudioContext({ latencyHint: 'interactive' })` created and resumed on the first user gesture (Play tap, retried on first touch); suspended/resumed on `visibilitychange`.
- Listener = render camera (position, forward, up) set once per frame. Voice chain: `AudioBufferSourceNode → GainNode → BiquadFilter(lp, 20 kHz pass-through unless occluded) → PannerNode(equalpower, inverse, refDistance 1.5, maxDistance = loudness radius, rolloff 1.2) → bus`. HRTF off. Own-weapon and UI sounds bypass the panner.
- **Occlusion:** one `StaticWorld.lineOfSight(listener, source)` at play start; blocked → lp 700 Hz and −6 dB. Sounds are short, so no per-frame updates.
- Polyphony 24 voices; priority = gain / distance; the lowest-priority voice is stolen. The same id within 25 ms is skipped (bots spraying). Bot footsteps play only within 14 m; gunfire always (it is a gameplay cue).
- Buses: `master (0.8, DynamicsCompressor −12 dB ratio 4) ← sfx (1.0, hp 90 Hz) ← { weapons, impacts, foley, explosions }; ← ui (0.7); ← ambient (0.12)`. Volume sliders map to `gain = (v / 100)²`.
- **Which events make sound.** World (spatialised) audio is played **only** from `sound` events (§11.5 emission table; variant = `(tick + player) % variants`, no RNG). The engine additionally derives listener-relative cues that are not world sounds: `hitmarker`/`headshot_ding` from `hit` when `attacker == local.id`, `hit_body/head/armor` from `hit` when `victim == local.id`, `flash_ring` from `blinded` for the local player, the `bomb_beep` schedule from `bombPlanted`/`bombDefused`/`bombExploded`, `round_start/win/lose` from `roundPhase`/`roundEnd`, `buy`/`buy_denied` from `buy`, and UI clicks through `AudioEngine.ui()`. It ignores `shot`, `footstep`, `reload`, `impact`, `grenadeBounce` etc. for playback — those drive visuals/HUD/stats only — so nothing is played twice.
- **Haptics are not audio:** `platform/haptics.ts` (L1) subscribes to the same drained events (fire 10 ms light, hit taken 20 ms, death 60 ms, explosion 120 ms) and calls the existing `bridge.haptic(kind)` (`CSNative.vibrate` or `navigator.vibrate`).

---

## 10. Visual style

Stylised "clean warehouse": flat-shaded, slightly saturated, strong value contrast between dark floors and mid-grey walls so bright team-coloured characters pop at phone size. `MeshLambertMaterial` (Low) / `MeshPhongMaterial` (Medium, High), **one `CanvasTexture` per material** (no atlas) with `RepeatWrapping` and UVs in world metres (1 repeat / 2 m), mipmaps, anisotropy 4 on High. All texture recipes take an explicit `Rng` (seed 1337) so output is deterministic and hashable.

### 10.1 Procedural textures (`render/textures/*.ts`, 256² Low / 512² Medium+, RGB)

| Material id | Recipe |
|---|---|
| `concrete` (walls) | base `#8d8f93`; 3-octave value noise (cells 32/16/8 px, amplitude 12/8/4); 40 speckles; horizontal seam every 128 px at alpha 0.15; 8 hairline cracks (random-walk polylines, alpha 0.4) |
| `concrete_base` (lowest wall band) | `concrete` + bottom 20 % dirt gradient + a 24 px yellow/black hazard stripe band at the top (45° stripes `#d8b400` / `#2a2a2a`) |
| `floor` | base `#4a4d52`; same noise; 1 px tile grid every 64 px alpha 0.25; 6 % of tiles darker; 3 oil-stain radial gradients |
| `floor_stripe` (site zones) | `floor` + diagonal hazard stripes 24 px |
| `crate_wood` (`c`, `X`) | base `#9a6b3a`; planks every 48 px with 2 px gaps; horizontal sine-noise grain alpha 0.1; 4 corner nails; diagonal brace `#7a5330` 10 px (X faces); stencil "DEPOT 03" / "货运" bold system font alpha 0.3 on one face |
| `sandbag` (`~`) | base `#8b8358`; rows of 64 × 28 px rounded rectangles offset half a width per row, light top edge, dark bottom shadow |
| `metal` (A platform, lips, ramps) | base `#6b7078`; diamond plate: 8 px rotated squares with light top-left / dark bottom-right edges; 3 rust blotches alpha 0.25 |
| `door_frame` | `#3f4a6b` with a 2 px light bevel |
| `ceiling` + `lamp` | `#2a2c30` with 1 % noise; emissive white quads (lamps) on a separate unlit material |
| `site_marker` | 256² transparent "A" / "B" in `#ffd54f` with a 4 px dark outline (floor decal + wall sign) |
| `skin_t` / `skin_ct` | `#c8a24a` sand / `#3d6fb5` blue, darker strap band at 60 % height, 4 % noise; CT adds a lighter vest panel and a "CT" stencil on the back; helmet `#2b2b2b` |
| `gun_metal` / `wood_stock` | `#2f3136` brushed horizontal noise + 1 px top highlight / `crate_wood` grain at 2× frequency, `#6b4a2a` |
| `blood_decal` / `bullet_hole` / `muzzle` | 128² 6 radial gradients `#7a0f0f` → 0 / 64² dark centre, grey ring, 8 cracks / 128² additive white → `#ffb347` → 0 with 6 spikes |
| `icons` | 64² Canvas-path weapon silhouettes, bomb, kit, helmet, skull → `toDataURL()` for HUD/buy menu backgrounds |

### 10.2 Models from primitives

**Characters (`render/models/humanoid.ts`)** — 11 boxes/cylinders, hierarchical, ≈ 170 triangles, materials by team; hitboxes in `weapons/hitscan.ts` use the same dimensions:

| Part | Geometry (m) | Pivot |
|---|---|---|
| Hips (root) | box 0.36 × 0.22 × 0.22 | y 0.95 |
| Torso + vest overlay (box 0.44 × 0.36 × 0.28 when armored) | box 0.5 × 0.6 × 0.3 | y 0.9–1.5 |
| Head + helmet half-sphere r 0.15 (when `helmet`) | box 0.24 × 0.26 × 0.24 | neck (y 1.5) |
| Upper arm / forearm ×2 | box 0.12 × 0.32 × 0.12 / 0.10 × 0.30 × 0.10 | shoulder / elbow |
| Thigh / shin ×2 | box 0.18 × 0.45 × 0.18 / 0.15 × 0.45 × 0.15 | hip / knee |
| Weapon | the viewmodel `Group`, scale 1 | right hand |
| Backpack / C4 | box 0.25 × 0.3 × 0.1; carrier shows a red blinking LED quad | back |

Procedural animation: legs swing `±35° · sin(phase)`, `phase` from distance travelled (stride 1.5 m); arms hold the weapon forward; torso pitches with aim pitch × 0.5; crouch = root −0.5 m, thighs 70°; hit flinch 8° away from the shot for 0.15 s; death = tip-over (pitch ±90° about the hips over 0.35 s away from the shot, sink 0.1 m, blob shadow fades), corpse frozen until round end (≤ 10). Blob shadow: `PlaneGeometry` 0.9 m with a radial-gradient alpha texture.

**Weapons (`render/models/weapons.ts`)** — each a `Group` of 4–8 boxes/cylinders in `gun_metal` with `wood_stock` accents, ≤ 200 triangles, with named children **`muzzle`** (tracer/flash origin), **`mag`** (reload animation) and **`slide`/`bolt`**: Glock (frame, slide, grip 15°, trigger guard), USP (+ suppressor cylinder), Deagle (longer slide, lightened metal), MP5 (receiver, mag, folded stock, suppressor), AK (receiver, wood handguard, curved mag = 3 boxes at 10° increments, stock, gas tube), M4 (receiver, rail box, carry handle, straight mag, stock tube), AWP (long barrel r 0.013 × 0.65, scope cylinder with lens disc and 2 rings, bipod, green `#4f5a3d` stock), knife (tapered blade box + grip cylinder), HE (sphere r 0.06 + lever box), flash (cylinder r 0.035 × 0.12, silver), C4 (box 0.3 × 0.1 × 0.2 + LED).

### 10.3 Lighting, shadows, fog, quality

- `AmbientLight 0.55` + `HemisphereLight(sky #cfd6e6, ground #3a3326, 0.5)` + one `DirectionalLight(0.8)` from (−1, 2, −0.5) for consistent face shading. **No shadow maps.** Depth cues come from baked per-vertex AO in the map geometry (vertex colours darkened 25 % within 0.5 m of floor–wall seams, computed by `render/mapMesh.ts`) and blob shadows under characters. High adds 4 `PointLight`s (sites, mid, CT spawn; distance 10 m, no shadows).
- Fog `FogExp2(#1c1e22, 0.018)`: limits readable contrast beyond 40 m, hides nothing on this map.
- Dressing (`render/dressing.ts`, render-only, deterministic): pipes along walls (thin cylinders), one lamp quad per 4 × 4 m, corrugated upper band on walls (`y 2.4–3.0`, `metal` tinted), door frames, site decals.

| Preset | DPR cap | Texture | Material | Point lights | Particles / decals / tracers | Target |
|---|---|---|---|---|---|---|
| 低 Low | 1.0 | 256² | Lambert | 0 | 60 / 32 / 32 | 60 fps on 2019 Snapdragon 6xx |
| 中 Medium (default) | 1.5 | 512² | Phong | 0 | 150 / 96 / 64 | 60 fps on 2020 mid-range |
| 高 High | min(2, native) | 512² + aniso 4 | Phong | 4 | 300 / 200 / 64 | flagships |
| 自动 Auto | starts Medium; `app/perf.ts` (the only p95 histogram owner, §12.3) steps down when p95 frame > 18 ms for 5 s and up when p95 < 12 ms for 30 s (max Medium on first run) by calling `renderer.setQuality()`; the renderer only implements the presets | | | | | |

Budget on Medium: ≤ 60 draw calls, ≤ 80 k triangles, ≤ 9 ms GPU; the static map is ≤ 8 merged draw calls (one per material via `BufferGeometryUtils.mergeGeometries`).

### 10.4 Camera & viewmodel (`render/cameraRig.ts`, `render/viewmodel.ts`)

- World camera: FOV 75° (setting 65–90), near 0.1, far 120; position = interpolated eye; orientation = `look + 0.5 · aimOffset` + hit shake (0.4° for 0.1 s) + explosion shake. AWP scoped: FOV → 20° / 10° over 0.15 s, DOM scope overlay (black outside a circle, 2 px cross), viewmodel hidden.
- **The viewmodel is rendered in its own `Scene` with its own camera (FOV 60, near 0.01) after the world pass with `renderer.autoClear = false` and `clearDepth()`**, so it never clips into walls. One extra draw call per weapon part.

| Motion | Model |
|---|---|
| Base pose | (0.18, −0.16, −0.35) right-lower |
| Idle sway | `x += 0.004 sin(0.9 t)`, `y += 0.003 sin(1.3 t + 1)`, breathing pitch 0.3° |
| Look sway | `rotY −= clamp(Δyaw · 0.6, −4°, 4°)`, `rotX −= clamp(Δpitch · 0.6, −3°, 3°)`, smoothed τ 0.08 s |
| Walk bob | `bobPhase += speed · DT · 2.4`; `x += 0.012 sin(bobPhase) · s`, `y += 0.008 |sin(2 bobPhase)| · s`, `s = speed / maxSpeed` (crouch halves) |
| Land | `y −= 0.05 · impact / 8`, recovers τ 0.12 s |
| Recoil kick | per shot `z += 0.03 · kick`, `rotX += 2.5° · kick`, `kick = P[0].pitch / 0.4`; spring k 160, c 14 |
| Reload | 3 phases timed to the weapon's reload: tilt 25° + lower 0.08 m (0–25 %); `mag` drops −0.15 m and returns (25–70 %); `slide`/`bolt` pull (70–100 %) |
| Switch | lower 0.25 m and rotate −40° over 0.15 s, swap at the bottom, raise 0.2 s |
| Knife / throw | swing rotY −60° → +30° over 0.25 s, stab z −0.15 over 0.12 s; throw: rotX −35° 0.2 s, release, lower 0.3 s |

### 10.5 Effects (`render/effects/*.ts`, all event-driven, never in the sim)

| Effect | Implementation | Pool |
|---|---|---|
| Muzzle flash | 2 crossed additive quads at `muzzle`, random roll, scale 0.12–0.25 m, 2 frames; `PointLight` 1 frame on High | per shot |
| Tracers | one `InstancedMesh` of thin boxes (0.02 × 0.02 × 1.5 m, additive yellow-white, alpha 0.6) travelling at 300 m/s, ≤ 120 ms; every 2nd auto shot, always for AWP; the human's start at the viewmodel muzzle re-projected into the world | 64 |
| Impacts | `Points` particle pool: concrete dust 8 grey, wood splinters 8, metal sparks 6 (gravity), sand 8; lifetime 0.4 s | per preset |
| Bullet holes | `InstancedMesh` 0.08 m quads oriented to the hit normal, 1 mm offset, ring buffer | per preset |
| Blood | 10 red particles + a decal on the nearest surface within 2 m behind the victim; 60 ms red emissive flash on the character | 64 decals |
| Hit feedback (human victim) | red edge arcs, 0.4° shake, haptic; (shooter) hit marker + `hitmarker` sound |
| HE / bomb explosion | additive sphere 0 → 3 m (bomb 0 → 10 m) over 120 ms with alpha fade + 40 grey smoke particles 1.5 s; shake `0.4 · clamp(1 − dist / 30)` for 0.6 s; bomb adds a white flash 150 ms |
| Flash | full-screen white DOM overlay (§8.1) + 12 bright particles |
| C4 | model with an emissive LED quad blinking in sync with `bomb_beep` |

---

## 11. Architecture

### 11.1 Principles

1. **Pure simulation.** `src/{core,world,maps,nav,weapons,rules,ai,sim,i18n,settings}` import nothing from `three`, the DOM or WebAudio. Enforced three ways: a per-folder `tsconfig.sim.json` with `"lib": ["ES2022"]` (no `DOM`), an ESLint `no-restricted-imports`/`no-restricted-globals` rule, and a vitest that imports every pure module in Node. None of this tooling exists yet: it is an **L1 day-0 deliverable** (§11.14).
2. **Commands in, events out.** The sim reads only `InputCommand`s (§7.8) and mutates `WorldState`; it emits typed `SimEvents` into a buffered bus that the app drains after each step. The sim never calls an adapter.
3. **Fixed timestep, interpolated render.** `FixedLoop` (exists in `core/loop.ts`) runs 0–`maxSteps` steps per frame (the app passes 8, §2.1); renderers interpolate between two `RenderSnapshot`s.
4. **Determinism.** All randomness via `RngStreams` with named streams (`fire`, `spread`, `ai`, `spawn`, `misc`) whose state lives in `WorldState`; iteration order is by ascending entity id; no `sort` without a stable id tiebreak; a golden-hash test runs on every PR.
5. **Renderer mirrors state.** Views are keyed by entity id and reconciled every frame (create/dispose); transient effects are event-driven and never part of state.
6. **Data-driven.** Map, weapons, patterns, difficulty, names, economy and i18n are plain data modules validated by tests.
7. **Day-0 integration.** Every interface below ships with a runnable stub (§11.14) so `npm run dev` boots end-to-end before any lane is finished; L1 is the integration lead and owns `src/app/`.

### 11.2 Lanes, modules, paths, LOC

| Lane | Owner of | Paths | Depends on | LOC |
|---|---|---|---|---|
| **L1 Core kernel, shared types, sim facade, app shell, platform, build** (integration lead) | `core/{math,rng,events,loop}.ts` (exist); **shared day-0 types** `sim/{state,events,brain,entities}.ts` + `settings/types.ts` (zero dependencies beyond `core`, frozen day 0, the module every other lane imports); **sim facade** `sim/{candidates,death,sim}.ts`; `main.ts`, `app/{game,matchSettings,stats,testHooks,perf}.ts`, `platform/{persist,android,pwa,haptics}.ts` (`persist`/`android` move from `app/`), `web/{index.html,sw.js,manifest}`, `tools/`, `android/`; **day-0 toolchain**: `tsconfig.sim.json`, `eslint.config.js` (+ `eslint`, `typescript-eslint`), vitest `pure`/`dom` projects (+ `jsdom`), npm scripts `lint`, `test:dom`, `bench`, `size`, `golden:update`, `tools/size.mjs`, `.nvmrc`, `.github/workflows/ci.yml` | — (app depends on everything) | 1,900 |
| **L2 World: map data, compiler, collision, movement, nav** | `maps/{depot,box}.ts`, `world/{types,compile,collision,movement}.ts` (`collision.ts` moves from `sim/world/` with its test; L2 owns it from then on and adds the optional `Solid` fields of §11.16), `nav/navgraph.ts` (replaces the deleted `sim/world/nav.ts`, §11.15), `tools/nav-dump.ts` | core, sim/state (types) | 1,700 |
| **L3 Weapons & combat** | `weapons/{defs,patterns,fire,hitscan,damage,grenade,inventory,items}.ts` | core, world, sim/state | 1,300 |
| **L4 Rules, economy, modes, i18n** | `rules/{round,economy,buyPlan,bomb,match,modes/defusal,modes/tdm,modes/training}.ts`, `i18n/{i18n,zh,en}.ts` (`i18n.ts` exists and is kept; L4 adds the dictionaries incl. all `weapon.*`, `item.*`, `area.*`, `bot.*` keys) | core, world, sim/state, weapons (defs) | 1,700 |
| **L5 AI** | `ai/{brain,perception,strategy,combat,steer,difficulty,names}.ts`, `tools/balance-sim.ts` | core, world, nav, sim/state, weapons (defs, fire), rules (buyPlan) | 1,600 |
| **L6 Renderer** | `render/{renderer,quality,cameraRig,mapMesh,dressing,viewmodel,radar}.ts`, `render/textures/*.ts`, `render/models/{humanoid,weapons,props}.ts`, `render/effects/{muzzle,tracers,decals,particles,explosions}.ts` | core, sim/state (snapshot/events types), world (renderHints), weapons (defs), **three** | 2,000 |
| **L7 Input & audio adapters** | `input/{inputSystem,touch,joystick,keyboard,gyro,aimAssist,layout}.ts`, `audio/{dsp,recipes,bank,engine}.ts` (`dsp.ts` exists and is kept) | core, sim/state, settings, weapons (defs), world/collision (`StaticWorld.lineOfSight` for occlusion) | 1,750 |
| **L8 UI** | `ui/{dom,hud,crosshair,buyMenu,layoutEditor,settings,onboarding}.ts`, `ui/screens/{mainMenu,modeSelect,pause,scoreboard,roundEnd,matchEnd,stats,rotate}.ts`, `ui/styles.css` | core, sim/state, settings, weapons (defs), rules (economy `canBuy`/`buyPlan` for affordability), i18n, platform (persist only — never `app/`) | 1,900 |

Total ≈ 12,850 lines of `src/` TypeScript + ≈ 2,500 lines of tests + ≈ 300 lines of tooling (+ ≈ 300 lines Kotlin). Allowed import direction (enforced by the ESLint rule): `core ← world ← nav`; `sim/{state,events,brain,entities}` and `settings/types` import only types from `core/math`, `core/rng`, `core/events`; `world/movement → {core, world, sim/state}` (it takes `maxSpeed: number`, never a `WeaponDef`); `weapons → {core, world, sim/state, sim/events}`; `rules → {core, world, sim/state, sim/events, weapons}`; `ai → {core, world, nav, sim/state, sim/events, sim/brain, weapons, rules}`; `sim/{candidates,death,sim}.ts → {core, world, nav, weapons, rules, sim/*}` and **never `ai`** (brains are injected through `sim/brain.ts`); adapters (`render`, `input`, `audio`, `ui`) → `{core, sim/state, sim/events, settings/types, world/types, world/collision (types + `StaticWorld` queries), weapons/defs, i18n}` plus `rules/economy` + `rules/buyPlan` for `ui` only and `platform/persist` for `ui` only; `platform → {core, sim/events types, settings/types}`; `app` → all.

### 11.3 Ownership of the shared mechanisms

| Mechanism | Owner | Location | Rule |
|---|---|---|---|
| Game loop | L1 | `core/loop.ts` (`FixedLoop`, exists), driven by `app/game.ts` | only `app/game.ts` constructs it (`maxSteps: 8`); `timeScale`, `fpsCap`, `pause(p: boolean)` are set only from the app |
| Sim event bus | L1 | `core/events.ts` (`EventBus<SimEvents>`), map in `sim/events.ts` | sim modules receive `out: SimEventSink` (= `emit` only); `Simulation` also records every envelope of the current tick in a private `tickEvents[]` for bot hearing (§11.6); app-side listeners run only on `drain()`; `guardReentrancy = true` in dev so listeners can never emit into the sim bus |
| Bot event delivery | L1 | `sim/sim.ts` step 8 | after step 7, for every envelope in `tickEvents` (emit order), for every **alive** bot in ascending id order: `brain.onEvent(e, mem, self, ctx)`; `onEvent` may mutate only `mem` and `state.teams[*]` and never emits; then the app drains |
| Death pipeline | L1 | `sim/death.ts` (§11.6.1) | the only place that credits kills, drops items, clears assignments and emits `death`; damage code only pushes `DeathInfo` |
| UI event bus | L8 (map) / L1 (instance) | `ui/dom.ts` defines `UiEvents`, `UiAction`, `ScreenData`; `app/game.ts` creates `new EventBus<UiEvents>()` and injects it into `Screens`, `BuyMenu`, `Hud` (no singleton) | settings/lang/quality/layout/screen changes and menu actions; never carries sim data |
| Settings types | L1 | `settings/types.ts` (`Settings`, `ControlSettings`, `TouchLayout`, `ControlId`, `QualityPreset`, defaults) | frozen day 0; imported by `input/`, `ui/`, `render/`, `platform/`, `app/` |
| Haptics | L1 | `platform/haptics.ts` | `haptics.handle(e, local)` maps drained events to `bridge.haptic(kind)`; L7 never vibrates |
| Lifetime stats | L1 | `app/stats.ts` | `stats.handle(e)` accumulates per match; `stats.commit(result)` merges into `cs.v1.stats` on `matchEnd` |
| Radar `Spotted[]` | L1 | `app/game.ts` | built from `spotted` events for `cfg.humanTeam`, entries expire after 180 ticks, passed to `Radar.draw` |
| Entity ids | L1 | `sim/entities.ts` | `allocId(state)` = `state.nextId++`; ids never reused in a match; human = 1, friendly bots 2…n, enemies n+1…2n, created in that order by `createMatch`; items/grenades/targets allocate on creation |
| `WorldState` / shared types | L1 | `sim/state.ts` (dependency-free) | frozen day 0; changes need the integration lead's sign-off and a golden-hash update |
| `RenderSnapshot` | L1 | `sim/state.ts` + `sim/sim.ts#writeSnapshot` | fixed-capacity numeric arrays, allocated once, double-buffered by the app |
| `InputCommand` | L1 | `sim/state.ts` | produced by `input/inputSystem.ts` (human) and `ai/brain.ts` (bots) |
| `CompiledMap` / `StaticWorld` / `NavGraph` | L2 | `world/types.ts`, `world/collision.ts`, `nav/navgraph.ts` | built once per match by the app, passed by reference |

### 11.4 Shared state types (`src/sim/state.ts`, plain data, no methods, no imports except `core/math` types)

```ts
import type { Vec3 } from '../core/math';
import type { RngState } from '../core/rng';

export type EntityId = number;
export type Team = 'T' | 'CT';
export type WeaponId = 'knife' | 'glock' | 'usp' | 'deagle' | 'mp5' | 'ak47' | 'm4a4' | 'awp' | 'he' | 'flash';   // exactly the 10 rows of §4.1
export const WEAPON_INDEX: readonly WeaponId[] = ['knife', 'glock', 'usp', 'deagle', 'mp5', 'ak47', 'm4a4', 'awp', 'he', 'flash'];   // fixed order; snapshots use the index, −1 = none
export type ItemId = WeaponId | 'kevlar' | 'kevlar_helmet' | 'defuse_kit' | 'c4';
export type Slot = 1 | 2 | 3 | 4;                      // primary, pistol, knife, grenade (the C4 has no slot)
export type HitZone = 'head' | 'chest' | 'stomach' | 'legs';
export type SurfaceId = 'concrete' | 'wood' | 'metal' | 'sand';
export type ModeId = 'defusal' | 'tdm' | 'training';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type RoundPhase = 'WARMUP' | 'FREEZE' | 'LIVE' | 'PLANTED' | 'SUDDEN_DEATH' | 'ROUND_END' | 'MATCH_END';
export type WinReason = 'elimination' | 'bomb' | 'defuse' | 'time' | 'draw';
export type BotStateId = 'DEAD' | 'BUY' | 'PLAN' | 'MOVE' | 'HOLD' | 'INVESTIGATE' | 'ENGAGE' | 'HUNT' | 'RETREAT' | 'PLANT' | 'DEFUSE';

export interface WeaponSlotState { id: WeaponId; mag: number; reserve: number }
export interface Inventory { primary: WeaponSlotState | null; pistol: WeaponSlotState; knife: true; he: number; flash: number; selectedGrenade: 'he' | 'flash'; active: Slot; pendingSlot: Slot | 0; switchEndsTick: number }
export interface ReloadState { startTick: number; endTick: number; weapon: WeaponId }
export interface PlayerStats { kills: number; deaths: number; headshots: number; shots: number; hits: number; damage: number; plants: number; defuses: number; mvps: number }

export interface PlayerState {
  id: EntityId; team: Team; isBot: boolean; nameKey: string;
  pos: Vec3; prevPos: Vec3; vel: Vec3; yaw: number; pitch: number; prevYaw: number; prevPitch: number;
  aimOffset: { yaw: number; pitch: number }; heat: number; shotIndex: number; lastShotTick: number; triggerHeld: boolean;
  hp: number; armor: number; helmet: boolean; alive: boolean; crouched: boolean; wantCrouch: boolean; grounded: boolean; scoped: 0 | 1 | 2;
  money: number; inv: Inventory; reload: ReloadState | null; hasBomb: boolean; hasKit: boolean;
  use: { action: 'none' | 'plant' | 'defuse' | 'pickup'; startTick: number; endTick: number; itemId: EntityId };
  throwing: { startTick: number; returnSlot: Slot } | null;      // §4.4 throw protocol
  spectating: EntityId | 0;                                      // dead players: whom the camera follows (sim-owned, §2.2)
  blindUntilTick: number; invulnerableUntilTick: number; respawnTick: number;
  lastDamage: { tick: number; from: Vec3; amount: number }; deathTick: number; deathDir: Vec3;
  legPhase: number; distanceWalked: number; lastFootstepDist: number;
  stats: PlayerStats; lastBuy: ItemId[];
}
export interface GrenadeState { id: EntityId; kind: 'he' | 'flash'; owner: EntityId; team: Team; pos: Vec3; prevPos: Vec3; vel: Vec3; explodeTick: number; bounces: number }
export interface ItemState { id: EntityId; kind: 'weapon' | 'bomb' | 'kit'; weapon?: WeaponSlotState; pos: Vec3; yaw: number; droppedTick: number }
export interface TargetState { id: EntityId; pos: Vec3; up: boolean; downUntilTick: number }
export interface BombState { state: 'none' | 'carried' | 'dropped' | 'planted' | 'exploded' | 'defused'; carrier: EntityId | 0; itemId: EntityId | 0; pos: Vec3; plantedTick: number; explodeTick: number; site: 'a' | 'b' | null }
export interface RoundState { phase: RoundPhase; phaseEndsTick: number; roundNumber: number; half: 1 | 2; suddenDeath: boolean; winner: Team | null; reason: WinReason | null; scoreT: number; scoreCT: number; lossStreakT: number; lossStreakCT: number; buyWindowEndsTick: number; mvp: EntityId | 0; tdmKillsT: number; tdmKillsCT: number; lastKill: { killer: EntityId | 0; victim: EntityId; headshot: boolean; weapon: WeaponId | 'fall' | 'bomb'; tick: number } | null }
export interface Blackboard { lastEnemySeen: { id: EntityId; pos: Vec3; tick: number; confidence: 0.5 | 1; by: EntityId }[]; bombPos: Vec3 | null; plannedSite: 'a' | 'b' | null; assignments: Record<EntityId, Goal>; rotateCalledTick: number }
export interface Goal { kind: 'site' | 'hold' | 'bomb' | 'investigate' | 'roam' | 'pickup'; pos: Vec3; holdSpot?: string; site?: 'a' | 'b'; untilTick?: number }
export interface BotMemory { id: EntityId; profile: BotProfile; state: BotStateId; stateSinceTick: number; goal: Goal | null; path: number[] /* nav node ids */; corners: Vec3[] /* pullString(path) */; pathIdx: number /* index into corners */; target: EntityId | 0; targetSeenSinceTick: number; targetLastSeenTick: number; lastKnown: Vec3 | null; aimErr: { x: number; y: number }; aimErrUntilTick: number; reactionUntilTick: number; aimYaw: number; aimPitch: number; burstLeft: number; pauseUntilTick: number; holdUntilTick: number; scanPhase: number; stuckCheckPos: Vec3; stuckTicks: number; blockedNode: number; blockedUntilTick: number; peek: { active: boolean; dir: number; untilTick: number } }
export interface BotProfile { nameKey: string; difficulty: Difficulty; preferredWeapon: 'rifle' | 'smg' | 'awp'; aggression: number; holdPreference: number }
export interface MatchOptions { autoPickup: boolean; scopeHold: boolean }   // human-only gameplay options the SIM needs (bots: always on); copied from Settings by app/matchSettings.ts, updatable mid-match via Simulation.setOptions()
export interface MatchConfig { mode: ModeId; seed: number; humanTeam: Team; difficulty: Difficulty; teamSize: 2 | 3 | 5; roundsToWin: 4 | 6 | 8; tdmSeconds: number; tdmKills: number; mapId: 'depot'; options: MatchOptions }

export interface WorldState {
  cfg: MatchConfig; tick: number; nextId: EntityId;
  rng: Record<'fire' | 'spread' | 'ai' | 'spawn' | 'misc', RngState>;
  players: PlayerState[];          // ascending id
  grenades: GrenadeState[]; items: ItemState[]; targets: TargetState[];
  bomb: BombState; round: RoundState;
  teams: { T: Blackboard; CT: Blackboard };
  bots: BotMemory[];               // one per bot, ascending id
  humanId: EntityId;               // always 1
  pendingDeaths: DeathInfo[];      // pushed by damage code during a tick, consumed by sim/death.ts in step 4b; always [] between steps
}

// ── also in sim/state.ts (shared by sim, rules, input, render, ui) ──
export interface DeathInfo { victim: EntityId; killer: EntityId | 0; weapon: WeaponId | 'fall' | 'bomb'; headshot: boolean; dir: Vec3 /* attacker → victim, unit */; point: Vec3 }
export type MoneyReason = 'kill' | 'plant' | 'defuse' | 'win' | 'loss' | 'plantedLoss' | 'buy' | 'halfReset';
export interface MoneyDelta { player: EntityId; delta: number; reason: MoneyReason }
export interface AimCandidate { id: EntityId; chest: Vec3; radius: number; vel: Vec3 }   // computed by sim/candidates.ts, consumed by input/aimAssist.ts
export interface LookPreview { yaw: number; pitch: number }                           // ABSOLUTE radians: the input layer's look incl. the not-yet-consumed drag delta, after aim assist
export interface Spotted { enemy: EntityId; x: number; z: number; yaw: number; tick: number }   // app-side radar list built from `spotted` events
export const TEAM_INDEX: Record<Team, 0 | 1> = { T: 0, CT: 1 };
export const ROUND_PHASE_INDEX: Record<RoundPhase, number> = { WARMUP: 0, FREEZE: 1, LIVE: 2, PLANTED: 3, SUDDEN_DEATH: 4, ROUND_END: 5, MATCH_END: 6 };
export const BOMB_STATE_INDEX: Record<BombState['state'], number> = { none: 0, carried: 1, dropped: 2, planted: 3, exploded: 4, defused: 5 };
export const USE_ACTION_INDEX: Record<PlayerState['use']['action'], number> = { none: 0, plant: 1, defuse: 2, pickup: 3 };
export const ITEM_KIND_INDEX: Record<ItemState['kind'], number> = { weapon: 0, bomb: 1, kit: 2 };
export const GRENADE_INDEX: Record<'he' | 'flash', 0 | 1> = { he: 0, flash: 1 };
export const IDLE_COMMAND: Readonly<InputCommand>;   // §7.8
```

### 11.5 Events (`src/sim/events.ts`; payloads are plain data; imports only `sim/state.ts` and `core` types)

```ts
export type SoundId =
  | 'fire_glock' | 'fire_usp' | 'fire_deagle' | 'fire_mp5' | 'fire_ak' | 'fire_m4' | 'fire_awp'
  | 'knife_swing' | 'knife_hit' | 'knife_stab' | 'reload_out' | 'reload_in' | 'reload_bolt' | 'switch_weapon' | 'dryfire'
  | 'footstep_concrete' | 'footstep_metal' | 'footstep_wood' | 'footstep_sand' | 'jump' | 'land'
  | 'impact_concrete' | 'impact_wood' | 'impact_metal' | 'impact_sand' | 'bullet_whiz' | 'death'
  | 'he_pin' | 'he_bounce' | 'he_explode' | 'flash_explode'
  | 'bomb_plant' | 'bomb_defuse_tick' | 'bomb_defused' | 'bomb_explode' | 'bomb_pickup';
export interface SimEvents {
  roundPhase: { phase: RoundPhase; round: number; endsTick: number };
  roundEnd: { winner: Team | null; reason: WinReason; mvp: EntityId; deltas: MoneyDelta[] };
  matchEnd: { result: Team | 'draw'; scoreT: number; scoreCT: number };
  respawn: { player: EntityId; pos: Vec3 };
  shot: { shooter: EntityId; weapon: WeaponId; origin: Vec3; dir: Vec3; end: Vec3; hitPlayer: EntityId | 0 };
  hit: { attacker: EntityId; victim: EntityId; weapon: WeaponId; zone: HitZone; damage: number; armored: boolean; point: Vec3 };
  impact: { point: Vec3; normal: Vec3; surface: SurfaceId };
  nearMiss: { listener: EntityId; point: Vec3 };
  damageTaken: { victim: EntityId; from: Vec3; amount: number; hpLeft: number };
  death: { victim: EntityId; killer: EntityId | 0; weapon: WeaponId | 'fall' | 'bomb'; headshot: boolean; pos: Vec3; dir: Vec3 };
  footstep: { player: EntityId; pos: Vec3; surface: SurfaceId; walking: boolean };
  jump: { player: EntityId; pos: Vec3 }; land: { player: EntityId; pos: Vec3; impact: number };
  reload: { player: EntityId; weapon: WeaponId; phase: 'start' | 'mid' | 'end' };
  weaponSwitch: { player: EntityId; weapon: WeaponId }; dryFire: { player: EntityId; pos: Vec3 };
  knife: { player: EntityId; pos: Vec3; hit: boolean; stab: boolean };
  grenadeThrow: { id: EntityId; kind: 'he' | 'flash'; owner: EntityId; pos: Vec3 };
  grenadeBounce: { id: EntityId; pos: Vec3; surface: SurfaceId };
  grenadeExplode: { id: EntityId; kind: 'he' | 'flash'; pos: Vec3 };
  blinded: { player: EntityId; seconds: number };
  bombPickup: { player: EntityId }; bombDrop: { pos: Vec3 };
  bombPlantStart: { player: EntityId }; bombPlantStop: { player: EntityId };
  bombPlanted: { player: EntityId; pos: Vec3; site: 'a' | 'b' };
  bombDefuseStart: { player: EntityId; kit: boolean }; bombDefuseStop: { player: EntityId };
  bombDefused: { player: EntityId }; bombExploded: { pos: Vec3 };
  itemDrop: { id: EntityId; kind: ItemState['kind']; pos: Vec3 }; itemPickup: { id: EntityId; player: EntityId; kind: ItemState['kind'] };
  money: { player: EntityId; delta: number; reason: MoneyReason };
  buy: { player: EntityId; item: ItemId; ok: boolean; error?: 'money' | 'window' | 'zone' | 'owned' | 'team' | 'max' };
  sound: { id: SoundId; pos: Vec3; loudness: number; player: EntityId | 0 };         // the ONLY source of world audio (§9.3) AND of bot hearing (§6.3); see the emission table below
  spotted: { team: Team; enemy: EntityId; pos: Vec3; by: EntityId };                  // radar; emitted by brains (ctx.out) and by sim/candidates.ts for the human
  targetHit: { id: EntityId }; targetReset: { id: EntityId };                        // training
  botState: { bot: EntityId; state: BotStateId };                                    // debug overlay only
}
export type SimEventSink = { emit<K extends keyof SimEvents>(k: K, e: SimEvents[K]): void };
```
`UiEvents` is **not** here: it references DOM-side types and lives in `ui/dom.ts` (§11.16).

**`sound` emission table (sim side; loudness = hearing radius in metres, §6.3).** Each row is emitted *in addition to* its specific event; audio plays only the `sound` row, bots hear only the `sound` row.

| Emitter | Action | `SoundId` | loudness |
|---|---|---|---|
| `weapons/fire.ts` (`tickWeapon`) | shot: pistol / MP5 / AK, M4 / AWP | `fire_<id>` | 30 / 40 / 40 / 60 |
| `weapons/fire.ts` | knife swing / hit / stab; dry fire; switch; reload start / mid / end | `knife_*`, `dryfire`, `switch_weapon`, `reload_out` / `reload_in` / `reload_bolt` | 8 / 3 / 3 / 8 |
| `weapons/hitscan.ts` | bullet impact on a solid (surface-mapped); ray within 1.5 m of a head | `impact_<surface>`; `bullet_whiz` (pos = closest point) | 10; 5 |
| `world/movement.ts` | running footstep (surface-mapped); jump; land | `footstep_<surface>`, `jump`, `land` | 10 / 8 / 10 (walking and crouching emit nothing) |
| `weapons/grenade.ts` | throw; bounce; HE burst; flash burst | `he_pin`, `he_bounce`, `he_explode`, `flash_explode` | 5 / 15 / 60 / 60 |
| `rules/bomb.ts` | plant start; defuse progress (every 20 ticks); defused; exploded; bomb picked up | `bomb_plant`, `bomb_defuse_tick`, `bomb_defused`, `bomb_explode`, `bomb_pickup` | 25 / 15 / 30 / 1000 (global) / 5 |
| `sim/death.ts` | death | `death` | 15 |

`bomb_beep`, hit feedback, flash ring, round stingers and UI clicks are *listener-relative* and are derived by the audio engine from the specific events (§9.3); they are never `sound` events.

### 11.6 Game loop & frame sequence (`app/game.ts`)

```
Game.startMatch(cfg):                                 // boot sequence (app/game.ts)
  map    = compileMap(depot, cfg.mode == 'training' ? 'training' : 'match')
  world  = new StaticWorld(map.solids, { groundY: 0, bounds: map.bounds }); nav = buildNavGraph(map, world)
  profiles = makeProfiles(cfg)                        // ai/, derived Rng (§6.1); the stub app passes undefined → defaultProfiles
  sim    = new Simulation({ map, world, nav, brains: createBotBrain() }, cfg, profiles)   // Simulation owns `streams = new RngStreams(cfg.seed)`
  renderer.loadMap(map); radar.loadMap(map); audio.setWorld(world); input.setLook(spawnYaw, 0)
  loop   = new FixedLoop(tick, render, { maxSteps: 8 }); loop.start()

FixedLoop.tick(dt):                                   // called 0–8× per frame (timeScale 4 for "skip round", 0.5 for the kill-cam)
  cmd  = input.sample(sim.state.tick + 1, sim.aimCandidates(), next.local)   // absolute yaw/pitch; latched buttons; aim assist applied; eye from local.eyeX/Y/Z
  sim.step(cmd)                                       // 1 round/mode (tickRound + MODES[mode].tick; nav.clearCache() on FREEZE)
                                                      // → 2 teamThink(T), teamThink(CT), then think() for every alive bot by id (→ bot commands)
                                                      // → 3 movement for all alive players by id (movePlayer with maxSpeed from WEAPONS) incl. fall damage
                                                      // → 4 weapons & hitscan (tickWeapon by id) → 4b DEATH PIPELINE (§11.6.1) → 5 grenades (stepGrenades) → 4b again
                                                      // → 6 items/bomb/use (tryPickup, tickBomb) → 4b again → 7 economy/scores → 8 bot onEvent delivery (§11.3) → state.rng = streams.serialize(); tick++
  swap(prev, next); sim.writeSnapshot(next)
  for e of sim.events.drain(): audio.handle(e, next.local); renderer.handleEvent(e); hud.handleEvent(e); haptics.handle(e, next.local); stats.handle(e); game.handleEvent(e)
                                                      // game.handleEvent: roundEnd → timeScale 0.5 for 1.5 s wall; roundPhase → timeScale 1, screens; spotted → Spotted[]; matchEnd → stats.commit
FixedLoop.render(alpha, frameDt):
  preview = input.previewLook(sim.aimCandidates(), next.local)   // ABSOLUTE look incl. the not-yet-consumed drag delta, through the SAME applyAimAssist
  renderer.render(prev, next, alpha, preview, frameDt) // interpolates others; human camera orientation = preview + 0.5·aimOffset(next) (preview already contains look)
  if (frame % 3 == 0) { hud.update(next); radar.draw(next, spotted, preview.yaw) }   // 20 Hz
  audio.setListener(renderer.cameraPose())
```
- Fire presses shorter than a tick are latched by `inputSystem`, never dropped. Look latency is one frame (preview), movement one tick.
- `loop.fpsCap = 30` for battery saver; `visibilitychange` hidden → `loop.pause(true)` + `audio.suspend()`; the Android host dispatches `cs-pause`/`cs-resume` (existing `bridge.onLifecycle`), which do the same and land on the pause menu.
- Settings changes: the app's `EventBus<UiEvents>` `on('settingsChanged')` → `input.setSettings`, `renderer.setQuality/setFov`, `audio.setVolumes`, `loop.fpsCap`, `sim.setOptions({ autoPickup, scopeHold })`, `persist.set('settings')`.
- Debug namespace: **`globalThis.__cs`** (the name the existing `tools/e2e.mjs` already waits for): `{ ready: true, game, perf }` always; with `?test=1` the `TestHooks` functions (§11.16) are merged into the same object so `ctx.dbg('stepTicks', 600)` works.

#### 11.6.1 Death pipeline (`sim/death.ts`, L1)

Whoever drops a player's `hp` to ≤ 0 — `applyDamage` (hitscan, knife, HE), `rules/bomb.ts` (explosion) or `world/movement.ts` (fall damage, which subtracts `hp` itself) — does exactly this and nothing more: `hp = 0; alive = false; deathTick = tick; deathDir = dir; use.action = 'none'; reload = null; scoped = 0; throwing = null` and pushes a `DeathInfo` onto `state.pendingDeaths`. Then `Simulation.step` runs `processDeaths(state, map, out)` (step 4b, after weapons and again after grenades and bomb) which, for each entry in push order:

1. `victim.stats.deaths++`; if `killer` is an alive-or-dead **enemy**: `killer.stats.kills++`, `headshots++` if headshot, `rules/economy.onKill(state, killer, weapon, out)` credits `killReward(WEAPONS[weapon] ?? null)` (emits `money`); a kill by the bomb or a fall credits nobody.
2. `weapons/items.dropItem(state, victim, 'weapon', out)` if a primary is held, then `dropItem(state, victim, 'bomb', out)` if `victim.hasBomb` (sets `bomb.state = 'dropped'`, `bomb.carrier = 0`, `bomb.itemId`, emits `bombDrop`); a defuse kit is never dropped.
3. If a plant/defuse was in progress the stop event was already emitted by the field reset; `delete state.teams[victim.team].assignments[victim.id]`; the victim's `spectating` is set per §2.2; every alive teammate's `BotMemory.target == victim.id` is cleared by `onEvent` (step 8), not here.
4. `state.round.lastKill = { killer, victim, headshot, weapon, tick }` (source of `SnapLocal.lastKill` and of `round.mvp`: most kills this round, ties by earliest kill tick, then lowest id — computed by `tickRound` on entering `ROUND_END`).
5. Emits `death { victim, killer, weapon, headshot, pos, dir }` and `sound 'death'`.

`pendingDeaths` is cleared afterwards, so it is always `[]` in `serialize()`/`hash()`. TDM respawn is scheduled by `tickRound` from `deathTick` (never here).

### 11.7 `RenderSnapshot` contract (`src/sim/state.ts`)

```ts
export interface SnapPlayer { id: number; nameKey: string; team: 0 | 1; alive: 0 | 1; x: number; y: number; z: number; yaw: number; pitch: number; crouch: 0 | 1; weapon: number /* WEAPON_INDEX, −1 none */; legPhase: number; hp: number; armor: number; helmet: 0 | 1; reloadT: number /* −1 or 0..1 */; scoped: 0 | 1; flinchT: number; deathT: number /* −1 or seconds since death */; hasBomb: 0 | 1; hasKit: 0 | 1; using: 0 | 1; kills: number; deaths: number; money: number /* scoreboard; −1 for enemies */ }
export interface SnapGrenade { id: number; kind: 0 | 1; x: number; y: number; z: number }
export interface SnapItem { id: number; kind: 0 | 1 | 2; weapon: number; x: number; y: number; z: number; yaw: number }
export interface SnapTarget { id: number; x: number; y: number; z: number; up: 0 | 1 }
export interface SnapLocal {
  id: number; alive: 0 | 1; hp: number; armor: number; helmet: 0 | 1; money: number; weapon: number; mag: number; reserve: number;
  primary: number; pistol: number; he: number; flash: number; selectedGrenade: 0 | 1; activeSlot: number;
  aimOffsetYaw: number; aimOffsetPitch: number; spreadDeg: number; crosshairTarget: 0 | 1 | 2; speed: number; grounded: 0 | 1; crouch: 0 | 1;
  scoped: 0 | 1 | 2; useAction: 0 | 1 | 2 | 3; useProgress: number; canBuy: 0 | 1; buyWindowRemaining: number; hasBomb: 0 | 1; hasKit: 0 | 1;
  eyeX: number; eyeY: number; eyeZ: number; x: number; z: number; throwHoldT: number /* −1 idle */;
  blindT: number; damageDirYaw: number; damageT: number; spectating: number; killerId: number; lastKill: { killer: number; victim: number; headshot: 0 | 1; weapon: number; t: number };
}
export interface RenderSnapshot {
  tick: number; time: number;
  playerCount: number; players: SnapPlayer[];                  // capacity 10
  grenadeCount: number; grenades: SnapGrenade[];               // capacity 16
  itemCount: number; items: SnapItem[];                        // capacity 32
  targetCount: number; targets: SnapTarget[];                  // capacity 8
  bomb: { state: 0 | 1 | 2 | 3 | 4 | 5; x: number; y: number; z: number; remaining: number; carrier: number };
  round: { phase: number; remaining: number; roundNumber: number; scoreT: number; scoreCT: number; aliveT: number; aliveCT: number; suddenDeath: 0 | 1 };
  local: SnapLocal;
}
export function createSnapshot(): RenderSnapshot;             // allocates capacities once
```
**Enum encodings (L1 writes, L6/L7/L8 read; the constants live in `sim/state.ts`, §11.4):**

| Field | Encoding |
|---|---|
| `SnapPlayer.team` | `TEAM_INDEX`: 0 = T, 1 = CT |
| `SnapPlayer.weapon`, `SnapLocal.weapon/primary/pistol`, `SnapItem.weapon`, `lastKill.weapon` | index into `WEAPON_INDEX` (`knife 0, glock 1, usp 2, deagle 3, mp5 4, ak47 5, m4a4 6, awp 7, he 8, flash 9`); −1 = none; `lastKill.weapon` −2 = fall, −3 = bomb |
| `bomb.state` | `BOMB_STATE_INDEX`: none 0, carried 1, dropped 2, planted 3, exploded 4, defused 5 |
| `round.phase` | `ROUND_PHASE_INDEX`: WARMUP 0, FREEZE 1, LIVE 2, PLANTED 3, SUDDEN_DEATH 4, ROUND_END 5, MATCH_END 6 |
| `SnapLocal.useAction` | `USE_ACTION_INDEX`: none 0, plant 1, defuse 2, pickup 3 |
| `SnapItem.kind` | `ITEM_KIND_INDEX`: weapon 0, bomb 1, kit 2 |
| `SnapGrenade.kind`, `SnapLocal.selectedGrenade` | `GRENADE_INDEX`: he 0, flash 1 (`InputCommand.grenade` is different: 0 keep, 1 he, 2 flash) |
| `SnapLocal.crosshairTarget` | 0 none, 1 enemy, 2 teammate |
| `SnapLocal.activeSlot` | `Slot` value 1–4 |
| `SnapLocal.canBuy`, `buyWindowRemaining` | `writeSnapshot` calls `rules/economy.canBuyNow(p, state, map)` (window **and** zone; TDM `buyAnywhere` ⇒ always 1) and `buyWindowRemaining = max(0, (round.buyWindowEndsTick − tick) / 60)` (TDM: −1 = unlimited) |
| `SnapLocal.spectating` | entity id or 0 |
| `SnapLocal.eyeX/Y/Z` | the human's eye (feet + 1.65 / 1.15 m), used by the input layer for aim assist |

Rules: `Simulation.writeSnapshot(out)` overwrites fields in place (no allocation: `nameKey` is a string reference copy); the app owns exactly two snapshots and swaps them; renderers must read `players[i]` only for `i < playerCount`; positions, `yaw`/`pitch` (shortest arc) and `legPhase` are interpolated `lerp(prev, next, alpha)` by id (an id present in only one buffer is drawn at `next`); every other field is taken from `next`. The human's camera ignores the snapshot orientation and uses `input.previewLook()` (§11.6).

### 11.8 Public interfaces (binding; frozen as `.d.ts`-equivalent stubs on day 0)

```ts
// ───────── core (L1; math/rng/events/loop already exist) ─────────
export interface Vec3 { x: number; y: number; z: number }           // + v3add/v3sub/v3scale/v3dot/v3cross/v3len/v3norm/v3lerp/dirFromYawPitch/forwardXZ/yawFromDir/clamp/lerp/damp/wrapAngle/approachAngle, Aabb
export class Rng { constructor(seed: number | RngState); state: RngState; next(): number; range(lo, hi): number; int(lo, hi): number; chance(p): boolean; gauss(mu?, sigma?): number; pick<T>(a: readonly T[]): T; shuffle<T>(a: T[]): T[]; fork(name: string): Rng }
export class RngStreams { constructor(seed: number, state?: Record<string, RngState>); get(name: string): Rng; serialize(): Record<string, RngState> }
export class EventBus<E> { tick: number; guardReentrancy: boolean; emit<K extends keyof E>(k: K, e: E[K]): void; on<K extends keyof E>(k: K, fn: (e: E[K], tick: number) => void): () => void; onAny(fn): () => void; drain(): EventEnvelope<E>[] }
export class FixedLoop { constructor(tick: (dt: number) => void, render: (alpha: number, frameDt: number) => void, opts?: LoopOptions /* step, maxSteps, maxFrameDt, now, raf, caf */); start(): void; stop(): void; pause(p: boolean): void; readonly isPaused: boolean; readonly isRunning: boolean; timeScale: number; fpsCap: number; readonly stats: LoopStats; readonly alpha: number }   // exists; pause(true)/pause(false), no resume()
export function allocId(state: WorldState): EntityId;              // sim/entities.ts

// ───────── world (L2) ─────────
export function compileMap(src: MapSource, variant?: 'match' | 'training'): CompiledMap;
export interface CompiledMap { id: string; cellSize: number; width: number; height: number; bounds: Aabb; solids: SolidDef[] /* index == StaticWorld solid id */; floorY(x: number, z: number): number; walk: WalkGrid; areas: WorldArea[]; areaAt(x: number, z: number): AreaId | null; sites: { a: WorldRect; b: WorldRect }; plantSpots: { a: Vec3; b: Vec3 }; spawns: { T: WorldSpawn[]; CT: WorldSpawn[] }; holdSpots: WorldHoldSpot[]; chokes: { id: string; pos: Vec3 }[]; renderHints: RenderHints; training?: { sealed: Aabb[]; targets: Vec3[]; onboardingPos: Vec3 } }   // supporting types: §11.16
export interface WalkGrid { cell: 1; cols: number; rows: number; walkable: Uint8Array; ramp: Uint8Array; floorY: Float32Array; index(x: number, z: number): number }
export function toSimSurface(s: CollisionSurfaceId): SurfaceId;      // world/types.ts: 8-value collision surface → 4-value sim surface (ground/brick/plaster → concrete, glass → metal)
export class StaticWorld {                                           // exists (moves to world/collision.ts); Solid gains optional penetrationFactor/kind (§11.16)
  constructor(solids: Array<Omit<Solid, 'id'>>, opts?: { cellSize?: number; groundY?: number | null; bounds?: Aabb });
  query(box: Aabb, out?: Solid[]): Solid[]; overlaps(box: Aabb): boolean;
  floorHeightAt(x: number, z: number, yStart: number, halfWidth?: number): number;
  raycast(origin: Vec3, dir: Vec3, maxDist?: number, filter?: (s: Solid) => boolean): RayHit | null;
  raycastAll(origin: Vec3, dir: Vec3, maxDist?: number): RayHit[];        // ordered by t, for penetration
  lineOfSight(a: Vec3, b: Vec3, filter?: (s: Solid) => boolean): boolean;
  moveBody(pos: Vec3, vel: Vec3, dt: number, shape: BodyShape, opts?: { wasGrounded?: boolean; snapDown?: boolean }): MoveResult;
  surfaceAt(x: number, z: number, y: number, halfWidth?: number): SurfaceId;
}
export function movePlayer(p: PlayerState, cmd: InputCommand, world: StaticWorld, maxSpeed: number, frozen: boolean, tick: number, state: WorldState, out: SimEventSink): void;   // world/movement.ts: §7.8 rule, accel/friction/jump/crouch/footsteps (+ `sound`), fall damage (pushes DeathInfo); used by humans and bots; maxSpeed = WEAPONS[active].speed or scopedSpeed, computed by sim.ts
export const PLAYER_SHAPE: { stand: BodyShape; crouch: BodyShape };   // BodyShape, Solid, RayHit, MoveResult are re-exported from world/collision.ts; world/types.ts re-exports them for adapters

// ───────── nav (L2) ─────────
export interface NavNode { id: number; pos: Vec3; area: AreaId | null; chokepoint: boolean; coverScore: number; coverHeight: number; nearWall: boolean; ramp: boolean; edges: number[] /* neighbour ids, ascending */ }   // plain arrays, no Set
export interface NavGraph { nodes: NavNode[]; nearest(p: Vec3): number; findPath(from: Vec3, to: Vec3, blocked?: number): number[] | null /* node ids */; pullString(ids: number[], out?: Vec3[]): Vec3[]; coverNear(p: Vec3, threat: Vec3, radius: number): NavNode | null; holdSpot(id: string): { node: number; yaw: number; crouch: boolean }; randomNodeInArea(area: AreaId, rng: Rng): NavNode; clearCache(): void }
export function buildNavGraph(map: CompiledMap, world: StaticWorld): NavGraph;

// ───────── weapons (L3) ─────────
export interface WeaponDef { id: WeaponId; slot: Slot; type: 'melee' | 'pistol' | 'smg' | 'rifle' | 'sniper' | 'grenade'; price: number /* knife 0 */; teams?: Team[]; dmg: number /* knife: slash */; melee?: { stab: number; stabRpm: number; backstabMult: number }; headMult: 4; rpm: number; auto: boolean; mag: number; reserve: number; reloadSec: number; spread: { stand: number; move: number; crouch: number; scoped?: number; scopedMove?: number }; perShot: number; heatRecover: number; pattern: [number, number][] /* degrees */; patternRecovery: number; speed: number; scopedSpeed?: number; falloff: number; ap: number; penetration: number | null; penetratesTallCrate: boolean; killReward: number; switchSec: number; maxCarry?: number /* he 1, flash 2 */ }   // display name = t('weapon.' + id)
export const WEAPONS: Record<WeaponId, WeaponDef>; export { WEAPON_INDEX } from '../sim/state'; export const ITEM_PRICES: Record<ItemId, number>;   // c4 and knife = 0
export function computeSpread(def: WeaponDef, p: Pick<PlayerState, 'vel' | 'crouched' | 'grounded' | 'heat' | 'scoped'>): number;          // degrees
export function applyRecoil(p: PlayerState, def: WeaponDef, rng: Rng): void;                                                                   // shotIndex, aimOffset
export function recoverRecoil(p: PlayerState, def: WeaponDef): void;                                                                           // per tick
export function sampleShotDir(yaw: number, pitch: number, aimOffset: { yaw: number; pitch: number }, spreadDeg: number, rng: Rng): Vec3;
export function tickWeapon(p: PlayerState, cmd: InputCommand, state: WorldState, world: StaticWorld, rng: RngStreams, out: SimEventSink): void;   // fire (spread: rng.get('spread'), recoil: rng.get('fire')) / reload / switch / scope / throw protocol; calls resolveHitscan + applyDamage, emits shot/hit/impact/nearMiss/targetHit/sound
export function resolveHitscan(origin: Vec3, dir: Vec3, shooter: PlayerState, players: PlayerState[], targets: TargetState[], world: StaticWorld, def: WeaponDef): HitResult[];   // ordered by t, ≤ 1 penetration; HitResult in §11.16
export function computeDamage(def: WeaponDef, dist: number, zone: HitZone): number;                                                             // round(dmg · falloff^(dist/10) · zoneMult); knife/HE callers pass their own number instead
export function applyDamage(victim: PlayerState, dmg: number /* AFTER falloff and zone */, zone: HitZone, ap: number, src: { attacker: EntityId; weapon: WeaponId | 'bomb'; headshot: boolean; dir: Vec3; point: Vec3 }, state: WorldState, out: SimEventSink): { dealt: number; armorDealt: number; killed: boolean };   // armour from victim.armor/helmet + zone (§4.1); emits damageTaken; on kill pushes DeathInfo (§11.6.1)
export function stepGrenades(state: WorldState, world: StaticWorld, out: SimEventSink): void;                                                   // deterministic, no RNG
export function resolveHE(center: Vec3, thrower: PlayerState, players: PlayerState[], world: StaticWorld): { victim: EntityId; damage: number }[];
export function resolveFlash(center: Vec3, players: PlayerState[], world: StaticWorld): { victim: EntityId; seconds: number }[];
export function dropItem(state: WorldState, p: PlayerState, kind: ItemState['kind'], out: SimEventSink): void; export function tryPickup(state: WorldState, p: PlayerState, auto: boolean, out: SimEventSink): void;   // auto = bots always, human iff cfg.options.autoPickup; called every tick by sim.ts step 6

// ───────── rules (L4) ─────────
export function createMatch(cfg: MatchConfig, map: CompiledMap, profiles: BotProfile[] | undefined, rng: RngStreams): WorldState;   // undefined → defaultProfiles(cfg); spawns/bomb carrier from rng.get('spawn'); targets from map.training
export function defaultProfiles(cfg: MatchConfig): BotProfile[];
export function tickRound(state: WorldState, map: CompiledMap, rng: RngStreams, out: SimEventSink): void;   // phases, timers, bomb carrier (spawn stream), TDM respawns via MODES[mode].respawn(…, rng.get('spawn')), sudden death, mvp, match end
export function tickBomb(state: WorldState, map: CompiledMap, out: SimEventSink): void;              // plant/defuse progress + resets (§2.2), explosion damage (applyDamage with weapon 'bomb'), plant/defuse money
export function canBuy(p: PlayerState, item: ItemId, state: WorldState, map: CompiledMap): { ok: true; price: number } | { ok: false; error: SimEvents['buy']['error'] };
export function canBuyNow(p: PlayerState, state: WorldState, map: CompiledMap): boolean;             // window AND zone (TDM: always true); used by writeSnapshot and the Buy pill
export function buy(p: PlayerState, item: ItemId, state: WorldState, map: CompiledMap, out: SimEventSink): boolean;
export function awardRoundEnd(state: WorldState, winner: Team | null, reason: WinReason, out: SimEventSink): MoneyDelta[];
export function onKill(state: WorldState, killer: PlayerState, weapon: WeaponId | 'fall' | 'bomb', out: SimEventSink): void;   // credits killReward, emits money; called only by sim/death.ts
export function killReward(def: WeaponDef | null): number;
export function buyPlan(money: number, team: Team, owned: Inventory & { armor: number; helmet: boolean; hasKit: boolean }, prefs: { sniper: boolean }, teamLossStreak: number, teamHasAwp: boolean, isLastRoundOfHalf: boolean): ItemId[];
export const MODES: Record<ModeId, GameMode>; export interface GameMode { freezeSec: number; liveSec: number; buyAnywhere: boolean; economy: boolean; bomb: boolean; respawn(state: WorldState, p: PlayerState, map: CompiledMap, rng: Rng): void; checkEnd(state: WorldState): { winner: Team | null; reason: WinReason } | null; tick(state: WorldState, map: CompiledMap, out: SimEventSink): void /* training: target pop-back; others: no-op */ }
// i18n/i18n.ts (EXISTS, kept verbatim): export type Locale = 'zh' | 'en'; t(key, params?); setLocale(l); getLocale(): Locale; onLocaleChange(fn: (l: Locale) => void): () => void; registerDictionary(locale, dict); detectLocale(language): Locale; missingKeys(locale): string[]; allKeys(): string[]   // fallback: current → en → zh → key

// ───────── sim (L1) ─────────
export interface ThinkContext { state: WorldState; map: CompiledMap; world: StaticWorld; nav: NavGraph; rng: Rng /* = streams.get('ai') */; tick: number; out: SimEventSink /* spotted, botState */ }
export interface BotBrain { think(ctx: ThinkContext, self: PlayerState, mem: BotMemory): InputCommand; onEvent(e: EventEnvelope<SimEvents>, mem: BotMemory, self: PlayerState, ctx: ThinkContext): void; teamThink(team: Team, ctx: ThinkContext): void }   // sim/brain.ts; one shared instance per difficulty; think() every tick; difficulty data via DIFFICULTY[mem.profile.difficulty] inside ai/
export type BotBrainFactory = (difficulty: Difficulty) => BotBrain;
export interface SimDeps { map: CompiledMap; world: StaticWorld; nav: NavGraph; brains: BotBrainFactory }
export class Simulation {
  constructor(deps: SimDeps, cfg: MatchConfig, profiles?: BotProfile[]);            // owns `streams = new RngStreams(cfg.seed)`; profiles undefined → defaultProfiles(cfg)
  readonly deps: SimDeps; readonly state: WorldState; readonly events: EventBus<SimEvents>;
  step(cmd: InputCommand): void;                                                    // exactly one tick, §11.6 order; writes state.rng = streams.serialize() at the end
  writeSnapshot(out: RenderSnapshot): void;
  aimCandidates(): AimCandidate[];                                                  // LOS-checked, ≤ 40 m, in front of the camera (sim/candidates.ts); also emits `spotted` for the human each tick
  setOptions(o: Partial<MatchOptions>): void;                                       // writes state.cfg.options (human-only options, §4.4)
  freezeBots(b: boolean): void;                                                     // tests: bots get IDLE_COMMAND instead of think(); not serialised
  serialize(): string; static restore(json: string, deps: SimDeps): Simulation;     // rebuilds streams from state.rng
  hash(): number;                                                                   // FNV-1a over a canonical JSON of state (golden tests, §11.10)
}

// ───────── ai (L5) ─────────
export function createBotBrain(): BotBrainFactory;                                  // returns think()/onEvent()/teamThink() implementing §6
export function makeProfiles(cfg: MatchConfig): BotProfile[];                        // uses new Rng(cfg.seed).fork('profiles'); nameKeys from BOT_NAME_KEYS
export function perceive(ctx: ThinkContext, self: PlayerState, mem: BotMemory, cfg: DifficultyCfg): Perception;   // Perception, DifficultyCfg in §11.16
export function planTeam(team: Team, ctx: ThinkContext): void;                      // writes state.teams[team].assignments; called only from teamThink()
export const DIFFICULTY: Record<Difficulty, DifficultyCfg>; export const BOT_NAME_KEYS: readonly string[];   // 12 keys 'wang', 'qiang', … → nameKey 'bot.' + key

// ───────── render (L6) ─────────
export class GameRenderer {
  constructor(canvas: HTMLCanvasElement, opts: { quality: QualityPreset; fov: number });
  loadMap(map: CompiledMap): void;                                                  // builds merged map meshes from renderHints
  render(prev: RenderSnapshot, next: RenderSnapshot, alpha: number, preview: LookPreview, frameDt: number): void;
  handleEvent(e: EventEnvelope<SimEvents>): void;                                   // effects, kill-cam, death poses
  setQuality(q: QualityPreset): void; setFov(deg: number): void; resize(w: number, h: number, dpr: number): void; dispose(): void;
  cameraPose(): { pos: Vec3; fwd: Vec3; up: Vec3 };
  readonly stats: { drawCalls: number; triangles: number; frameMs: number };
  menuScene(on: boolean): void;                                                     // main-menu cinematic
  setMarker(pos: Vec3 | null): void;                                                // onboarding move target (§2.4)
}
export class Radar { constructor(canvas: HTMLCanvasElement); loadMap(map: CompiledMap): void; draw(next: RenderSnapshot, spotted: Spotted[], yaw: number): void }
export function paintTexture(id: MaterialId, size: number, rng: Rng, ctx: Ctx2D): void;   // render/textures: pure recipe over a minimal Ctx2D interface (tests inject a recording fake)
export function makeTexture(id: MaterialId, size: number, rng: Rng): HTMLCanvasElement;    // creates a canvas and calls paintTexture

// ───────── input (L7) ─────────  (AimCandidate and LookPreview are defined in sim/state.ts, §11.4)
export function applyAimAssist(delta: { yaw: number; pitch: number }, look: LookPreview, eye: Vec3, candidates: AimCandidate[], level: 0 | 1 | 2 | 3, dt: number, dragging: boolean, strafing: boolean): { yaw: number; pitch: number };
export class InputSystem {
  constructor(root: HTMLElement, settings: ControlSettings, layout: TouchLayout);
  sample(tick: number, candidates: AimCandidate[], local: SnapLocal): InputCommand;   // consumes accumulated deltas; latches buttons; eye = local.eyeX/Y/Z; auto-fire, auto-reload, crouch toggle, 70 % RPM pulsing from WEAPONS
  previewLook(candidates: AimCandidate[], local: SnapLocal): LookPreview;
  press(btn: Btn): void; setBuy(item: ItemId): void; spectate(dir: -1 | 1): void;    // UI → next command (one-tick latches)
  setLayout(l: TouchLayout): void; setSettings(s: ControlSettings): void; setTouchVisible(b: boolean): void; attach(): void; detach(): void;
  setLook(yaw: number, pitch: number): void;                                        // on spawn / spectate / restore
}

// ───────── audio (L7) ─────────
export class AudioEngine { constructor(); unlock(): Promise<void>; suspend(): void; resume(): void; handle(e: EventEnvelope<SimEvents>, local: SnapLocal): void; setListener(p: { pos: Vec3; fwd: Vec3; up: Vec3 }): void; setWorld(world: StaticWorld): void; setVolumes(v: { master: number; sfx: number; ui: number }): void; ui(id: 'tap' | 'back' | 'buy' | 'denied'): void; startAmbient(): void; stopAmbient(): void }   // no haptics (platform/haptics.ts)
export type BankId = SoundId | 'hitmarker' | 'headshot_ding' | 'hit_body' | 'hit_head' | 'hit_armor' | 'flash_ring' | 'bomb_beep' | 'round_start' | 'round_win' | 'round_lose' | 'buy' | 'buy_denied' | 'ui_tap' | 'ui_back' | 'radio_spotted' | 'radio_bomb' | 'radio_rotate' | 'ambient_hum';
export function renderRecipe(id: BankId, variant: number): Float32Array;           // audio/recipes.ts, pure, built on audio/dsp.ts

// ───────── ui (L8) ─────────
export class Hud { constructor(root: HTMLElement, bus: EventBus<UiEvents>); update(next: RenderSnapshot): void; setView(v: { fovDeg: number; width: number; height: number }): void; handleEvent(e: EventEnvelope<SimEvents>): void; setLayout(l: TouchLayout): void; show(b: boolean): void }   // 20 Hz; crosshair from next.local.aimOffset* + setView (§8.1)
export type ScreenName = 'main' | 'mode' | 'settings' | 'buy' | 'pause' | 'scoreboard' | 'roundEnd' | 'matchEnd' | 'stats' | 'onboarding' | 'rotate' | 'loading';
export class Screens { constructor(root: HTMLElement, bus: EventBus<UiEvents>); show<S extends ScreenName>(s: S, data?: ScreenData[S]): void; hide(s: ScreenName): void; visible(): ScreenName[]; back(): boolean }   // ScreenData in §11.16
export class BuyMenu { constructor(root: HTMLElement, bus: EventBus<UiEvents>); open(local: SnapLocal, team: Team): void; close(): void; onBuy(fn: (item: ItemId) => void): void }   // the app wires onBuy → input.setBuy(item); no uiBus singleton anywhere

// ───────── platform (L1) ─────────
export type PersistKey = 'settings' | 'layout' | 'stats' | 'onboarding' | 'match' | 'locale' | 'loadout' | 'lastSettings';   // platform/persist.ts (exists as app/persist.ts; moved, key added)
export const persist: { get<T>(key: PersistKey, def: T): T; set<T>(key: PersistKey, v: T): boolean; remove(key: PersistKey): void; update<T extends object>(key: PersistKey, patch: Partial<T>, def: T): T; available(): boolean }; export function setStorageForTests(s: StorageLike | null): void;
// platform/android.ts (exists as app/bridge.ts; moved, API kept): window.CSNative { platform(); version(); vibrate(ms, amplitude); cancelVibration(); exit() }, window.__csBack(): 'handled' | 'exit' | 'none', DOM events cs-back / cs-pause / cs-resume
export type HapticKind = 'light' | 'medium' | 'heavy' | 'fire' | 'hit' | 'kill' | 'damage';
export const bridge: { isAndroidApp(): boolean; isStandalonePwa(): boolean; platformName(): 'android-app' | 'pwa' | 'browser'; isTouch(): boolean; hapticsEnabled: boolean; haptic(kind: HapticKind): void; onBack(handler: () => 'handled' | 'exit' | 'none'): () => void; onLifecycle(handler: (s: 'pause' | 'resume') => void): () => void; exit(): void; requestImmersive(): Promise<void> };
export const haptics: { handle(e: EventEnvelope<SimEvents>, local: SnapLocal): void };   // platform/haptics.ts → bridge.haptic
export const pwa: { register(): void; onUpdateAvailable(fn: () => void): void; applyUpdate(): void };   // platform/pwa.ts; fullscreen/orientation are bridge.requestImmersive()
```

### 11.9 Data flow

```
Touch / mouse / gyro ─► InputSystem.sample() ─► InputCommand ─► Simulation.step() ─► WorldState
                                     ▲                                 │
      AimCandidate[] (LOS-checked) ──┘                                 ├─ EventBus<SimEvents> ─► AudioEngine (voices, spatial)
                                                                       │                      ─► GameRenderer.handleEvent (effects)
                                                                       │                      ─► Hud.handleEvent (feed, notices)
                                                                       │                      ─► haptics, stats/persist, bot hearing (inside sim)
                                                                       └─ writeSnapshot() ─► RenderSnapshot(prev, next) ─► GameRenderer.render / Hud.update / Radar.draw
```

### 11.10 Determinism & RNG streams

- Streams and their only users: `fire` (recoil jitter, hit tiebreaks), `spread` (shot cones), `ai` (every bot decision, perception noise, strategy), `spawn` (spawn points, bomb carrier, TDM respawns), `misc` (reserved, currently unused — sound variants are chosen by the audio adapter from `tick`, target pop-ups are deterministic, bot profiles use a derived `Rng`). Adapters use their own `Rng(1337)` for textures/audio variants — never a sim stream.
- **Handles, not state.** `Simulation` owns the single `RngStreams` instance; every pure function that needs randomness receives it (`tickWeapon`, `tickRound`, `createMatch`: `rng: RngStreams`; `applyRecoil`, `GameMode.respawn`, `ThinkContext.rng`: one `Rng` taken from it). `WorldState.rng` is a **copy** written by `step()` after step 8 (`state.rng = streams.serialize()`) so that `serialize()`/`hash()` see the current state; `restore()` rebuilds `new RngStreams(cfg.seed, state.rng)`. Nobody may construct `new Rng(state.rng.x)` inside a tick — the existing constructor copies the state, so draws would never advance.
- Everything iterates by ascending id; `WorldState.players` is kept sorted; bot think order is by id with the stagger keyed on the `bots[]` index (§6.2); no `Map`/`Set` iteration in the sim (`NavNode.edges` is a sorted array).
- `Simulation.hash()` = FNV-1a over `JSON.stringify` of the state with numbers rounded to 1e-6, used by the golden test and by `__cs` hooks. **Toolchain pinning:** `Math.exp/sin/cos/atan2/hypot` may differ in the last bit between V8 versions and a divergent `chance(p)` can flip a branch, so the golden file is only required to match on the pinned Node version (`.nvmrc` = 22, `engines.node`, CI uses it); a toolchain bump regenerates it with `npm run golden:update` in the same PR. The restore-equals-continuous and two-sims-equal tests are machine-independent and always run.

### 11.11 Serialisation

`serialize()` = `JSON.stringify(state)` (all fields are plain data including `rng`, `bots` and the always-empty `pendingDeaths`); `restore(json, deps)` rebuilds `RngStreams` from `state.rng` and re-derives nothing — `restore(serialize(s))` followed by N steps equals N steps on the original (tested). `structuredClone(state)` is valid for tests. Stored to `cs.v1.match` at every FREEZE start, ≈ 40 KB; `freezeBots` and `tickEvents` are not state and are not stored.

### 11.12 Persistence (`platform/persist.ts` = the existing `app/persist.ts` moved; `localStorage`, JSON, try/catch, `set()` returns `false` when storage is unavailable)

| Key | Content |
|---|---|
| `cs.v1.settings` | `Settings` (§11.16; all §8.5 settings) |
| `cs.v1.layout` | `TouchLayout` (§11.16): `{ controls: { [ControlId]: { x: number; y: number; size: number } }, scale, opacity, leftHanded }` |
| `cs.v1.loadout` | TDM respawn loadout `ItemId[]` (existing key) |
| `cs.v1.stats` | `{ matches, wins, draws, kills, deaths, headshots, shots, hits, damage, bestStreak, byWeapon: { [id]: { kills, shots, hits } }, byAssist: Record<0|1|2|3, number> }` |
| `cs.v1.onboarding` | `{ done: boolean; assistChosen: boolean }` |
| `cs.v1.match` | `{ cfg: MatchConfig; state: string /* serialize() */; savedAt: number }`, cleared on match end / quit |
| `cs.v1.lastSettings` | last `MatchConfig` for 「再来一局」 |
| `cs.v1.locale` | `'zh' | 'en'` |

### 11.13 i18n (`i18n/i18n.ts` (exists), `zh.ts`, `en.ts`)

The existing `i18n/i18n.ts` is kept verbatim (`registerDictionary`, `t`, `setLocale`, `getLocale`, `onLocaleChange(fn: (l) => void)`, `detectLocale`, `missingKeys`, `allKeys`); L4 adds `zh.ts`/`en.ts` and registers both at boot. Flat `Record<string, string>` with `{param}` placeholders; zh is the source of truth; lookup order is the existing **current → en → zh → key** (the CI test fails on any key missing from either dictionary). DOM nodes carry `data-i18n="key"` and are re-filled on `onLocaleChange`; HUD numbers and times are locale-independent. **Single owner for every display name:** `WeaponDef`, `MapSource.areas[]`, `BotProfile` carry no strings — only L4's dictionaries do, under fixed key families that the other lanes reference by id: `weapon.<WeaponId>` (10) + `item.kevlar`, `item.kevlar_helmet`, `item.defuse_kit`, `item.c4`; `area.<AreaId>` (16, §3.2); `bot.<key>` for the 12 keys of `BOT_NAME_KEYS` (§6.1); `map.depot`; `mode.<ModeId>`; `reason.<WinReason>`. Default: `detectLocale(navigator.language)` (`zh*` → zh, else en), persisted override in `cs.v1.locale`.

### 11.14 Day-0 stubs & integration plan

Checked in by L1 **on day 0** together with the frozen interfaces so the app boots end-to-end before any lane starts: (a) the shared-types module `sim/{state,events,brain,entities}.ts` + `settings/types.ts` with every type of §11.4, §11.5, §11.16 and the index constants; (b) `.d.ts`-equivalent stubs for every §11.8 export; (c) the file moves of §11.15 (`git mv` with their tests); (d) the toolchain that does not exist yet: `tsconfig.sim.json`, `eslint.config.js` with the import-direction rule (§11.2), `vitest.config.ts` projects `pure` (node) and `dom` (jsdom, `input/` + `ui/`), devDependencies `jsdom`, `eslint`, `typescript-eslint`, `@vitest/coverage-v8`, npm scripts `lint`, `test:dom`, `bench`, `size`, `golden:update`, `tools/size.mjs`, `.nvmrc`, `.github/workflows/ci.yml` (§14.5), and `check` extended to run them; (e) runnable stubs: `NullRenderer` (clears the canvas, draw calls = 0), `IdleBot` (returns a clone of `IDLE_COMMAND`) and `RandomBot` (random walk + occasional fire from `ctx.rng`; used by the first balance smoke), `SilentAudio`, `ScriptedInput` (replays a command log — also used by the golden test), a 6 × 6 `maps/box.ts` test map, and `Hud`/`Screens` with plain text. Week 1: interfaces + stubs + CI green; week 2: each lane replaces its stub behind the same interface; the integration lead merges daily and keeps `npm run check` green; gameplay-changing merges update the golden hash in the same PR.

### 11.15 Existing files: keep / move / delete (done by L1 on day 0)

| Existing file | Decision | Notes |
|---|---|---|
| `src/core/{math,rng,events,loop}.ts` + tests | **keep** | APIs as documented; `FixedLoop.pause(p: boolean)`; there is no `core/ids.ts` (ids live in `sim/entities.ts`) |
| `src/sim/world/collision.ts` + `tests/unit/sim/collision.test.ts` | **move** → `src/world/collision.ts`, `tests/unit/world/collision.test.ts` | L2 owns it afterwards and adds the optional `Solid.penetrationFactor` / `Solid.kind` fields (§11.16); `SurfaceId` stays 8-valued there, `toSimSurface` maps it |
| `src/sim/world/nav.ts` + `tests/unit/sim/nav.test.ts` | **delete** | superseded by `nav/navgraph.ts` (§6.4): different node shape, id-returning `findPath`, no `Set` in the sim; L2 may lift its A*/heap code |
| `src/app/persist.ts` + test | **move** → `src/platform/persist.ts` | API kept (`get/set(): boolean/remove/update/available`, `setStorageForTests`); `PersistKey` gains `'lastSettings'` |
| `src/app/bridge.ts` | **move** → `src/platform/android.ts` | API and the `CSNative` / `__csBack` / `cs-*` protocol kept verbatim; the §14.4 `AndroidBridge` design is withdrawn |
| `src/audio/dsp.ts` + test | **keep** (name kept) | `audio/synth.ts` is withdrawn; recipes build on `dsp.ts` (§9.1) |
| `src/i18n/i18n.ts` + `tests/unit/app/i18n.test.ts` | **keep** (name kept; test moves to `tests/unit/i18n/`) | `i18n/t.ts` is withdrawn; API in §11.8 |
| `tools/{build,serve,e2e,png,sync-android}.mjs`, `tools/apk/` | **keep** | `build.mjs` stays `iife` + stamping (§14.2); `e2e.mjs` keeps `globalThis.__cs` (§11.6) |
| `android/.../{MainActivity,NativeBridge}.kt` | **keep** | §14.4 reconciled to the existing protocol; no new bridge methods |
| `package.json`, `vitest.config.ts`, `tsconfig.json` | **extend** | per §11.14 (d) |

### 11.16 Supporting types by file (binding; all plain data)

```ts
// settings/types.ts (L1, zero deps) — imported by input/, ui/, render/, platform/, app/
export type QualityPreset = 'low' | 'medium' | 'high' | 'auto';
export type ControlId = 'joystick' | 'fireR' | 'fireL' | 'jump' | 'crouch' | 'reload' | 'switch' | 'scope' | 'grenade' | 'grenadeSelect' | 'use' | 'buy' | 'pause';
export interface TouchLayout { controls: Record<ControlId, { x: number /* % width */; y: number /* % height */; size: number /* vh */ }>; scale: number /* 0.8–1.2 */; opacity: number /* 0.3–1 */; leftHanded: boolean }
export interface ControlSettings { sens: number; sensScoped: number; accel: boolean; aimAssist: 0 | 1 | 2 | 3; autoFire: boolean; tapToFire: boolean; doubleTapJump: boolean; twoFingerReload: boolean; recoilCrosshair: boolean; gyro: 'off' | 'drag' | 'always'; gyroSens: number; crouchMode: 'toggle' | 'hold'; autoReload: boolean; fovDeg: number }
export interface Settings { controls: ControlSettings; autoBuy: boolean; autoPickup: boolean; scopeHold: boolean; quality: QualityPreset; fpsCap: 30 | 60 | 0; batterySaver: boolean; haptics: boolean; volume: { master: number; sfx: number; ui: number }; locale: 'zh' | 'en' | 'auto' }
export const DEFAULT_SETTINGS: Settings; export const DEFAULT_LAYOUT: TouchLayout;   // §8.5 / §7.2 values

// world/types.ts (L2) — re-exports Solid, RayHit, MoveResult, BodyShape, SurfaceId as CollisionSurfaceId from world/collision.ts
export type AreaId = 't_spawn' | 't_north' | 't_south' | 'long' | 'mid' | 'tunnel' | 'ct_spawn' | 'site_a' | 'site_b' | 'a_ramp' | 'a_ramp_ct' | 'mid_window' | 'tunnel_window' | 'a_connector' | 'b_connector' | 'b_door_ct';
export type SolidKind = 'wall' | 'tallcrate' | 'lowcrate' | 'sandbag' | 'lip' | 'ramp-step' | 'platform' | 'lintel' | 'ceiling' | 'seal';
export interface SolidDef { box: Aabb; surface: CollisionSurfaceId; penetrable: boolean; penetrationFactor: number /* 0.6 crates/sandbags, 0.4 X for AWP, 0 otherwise */; kind: SolidKind; material: MaterialId | null /* null = invisible */; tag?: string }
// world/collision.ts Solid (L2 extends the frozen shape with OPTIONAL fields so old tests still pass): { id; box; surface; penetrable; tag?; penetrationFactor?: number; kind?: SolidKind }
export interface WorldRect { x0: number; z0: number; x1: number; z1: number; y: number }   // metres, inclusive of the cell edges
export interface WorldArea { id: AreaId; rect: WorldRect }
export interface WorldSpawn { pos: Vec3; yaw: number /* radians */ }
export interface WorldHoldSpot { id: string; pos: Vec3; yaw: number; team: Team | 'both'; crouch: boolean }
export interface RenderHints {
  solids: { material: MaterialId | null; kind: SolidKind; uvScale: 0.5 }[];                     // same index as CompiledMap.solids
  floorQuads: { rect: WorldRect; material: MaterialId }[];                                       // floor 0 per area rect + platform tops
  ramps: { origin: Vec3 /* low edge centre */; ascend: 'n' | 's' | 'e' | 'w'; from: number; to: number; width: 2; length: 2; material: MaterialId }[];   // wedge drawn over the stair boxes
  doorFrames: { pos: Vec3; axis: 'x' | 'z'; width: 2; height: 2.6; material: MaterialId }[];
  lamps: Vec3[];                                                                                 // one per 4 × 4 m of floor, y = ceilingY − 0.1
  siteDecals: { site: 'a' | 'b'; rect: WorldRect }[]; wallSigns: { site: 'a' | 'b'; pos: Vec3; yaw: number }[];
  radarWalls: { x0: number; z0: number; x1: number; z1: number }[];                              // top-down segments of kind wall/lip/tallcrate (seal excluded)
  bounds: Aabb; ceilingY: number;
}

// weapons/hitscan.ts (L3)
export interface HitResult { kind: 'player' | 'target' | 'solid'; id: EntityId | 0; t: number; point: Vec3; normal: Vec3; zone: HitZone | null; surface: SurfaceId; penetrated: boolean /* this hit came after a penetration */; damageScale: number /* 1 or the Pen factor */; dist: number }

// ai/perception.ts, ai/difficulty.ts (L5)
export interface Perception { visible: { id: EntityId; dist: number; angle: number; seenSinceTick: number }[]; best: EntityId | 0 /* recognised target */; heard: { pos: Vec3; tick: number; loudness: number }[]; threatDir: Vec3 | null }
export interface DifficultyCfg { recognitionSec: number; reactionSec: number; sigmaErrDeg: number; tauErrSec: number; tauTrackSec: number; turnRateDeg: number; fireConeDeg: number; pHead: number; burst: [number, number]; burstPauseSec: number; recoilControl: number; strafe: 'none' | 'peek' | 'counter'; visionM: number; hearingMult: number; retreatHp: number; courage: 'abort' | 'abort10m' | 'covered'; grenades: 'none' | 'he' | 'he+flash'; rotates: boolean; fakeDefuseP: number }

// render/textures/ctx.ts (L6) — the subset of CanvasRenderingContext2D the recipes may use (fakeable in Node)
export type Ctx2D = Pick<CanvasRenderingContext2D, 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'font' | 'textAlign' | 'fillRect' | 'strokeRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'closePath' | 'fill' | 'stroke' | 'fillText' | 'save' | 'restore' | 'translate' | 'rotate' | 'createLinearGradient' | 'createRadialGradient'>;

// ui/dom.ts (L8)
export type UiAction = 'play' | 'training' | 'continue' | 'rematch' | 'changeMode' | 'menu' | 'startMatch' | 'resume' | 'quit' | 'skipRound' | 'drop' | 'openBuy' | 'closeBuy' | 'spectatePrev' | 'spectateNext' | 'resetData' | 'applyUpdate' | 'marker' | 'onboardingDone';
export interface UiEvents { settingsChanged: Settings; langChanged: 'zh' | 'en'; qualityChanged: QualityPreset; layoutChanged: TouchLayout; screen: { name: ScreenName; visible: boolean }; action: { id: UiAction; payload?: unknown /* startMatch: MatchConfig; marker: Vec3 | null */ } }
export interface ScreenData {
  loading: { progress: number /* 0..1 */; label: string };
  roundEnd: { winner: Team | null; reason: WinReason; mvp: EntityId; deltas: MoneyDelta[]; scoreT: number; scoreCT: number; humanTeam: Team; names: Record<EntityId, string> };
  matchEnd: { result: Team | 'draw'; humanTeam: Team; scoreT: number; scoreCT: number; mvp: EntityId; personal: PlayerStats & { accuracy: number; hsPercent: number }; assistLevel: 0 | 1 | 2 | 3; cfg: MatchConfig };
  scoreboard: { snapshot: RenderSnapshot; humanTeam: Team; mvp: EntityId };
  stats: LifetimeStats; settings: undefined; buy: undefined; pause: { canBuy: boolean }; main: { canContinue: boolean; updateAvailable: boolean }; mode: { last: MatchConfig | null }; onboarding: { step: 0 | 1 | 2 }; rotate: undefined;
}

// app/stats.ts, app/testHooks.ts, app/perf.ts (L1)
export interface LifetimeStats { matches: number; wins: number; draws: number; kills: number; deaths: number; headshots: number; shots: number; hits: number; damage: number; bestStreak: number; byWeapon: Record<string, { kills: number; shots: number; hits: number }>; byAssist: Record<0 | 1 | 2 | 3, number> }   // cs.v1.stats
export interface TestHooks {                                             // merged into globalThis.__cs with ?test=1
  startMatch(cfg: Partial<MatchConfig>): void;                           // seed defaults to ?seed=
  stepTicks(n: number): void;                                            // SYNCHRONOUS: loop.pause(true); n × { sample, step, writeSnapshot, drain }; the loop stays paused until resume()
  resume(): void; freezeBots(b: boolean): void; teleport(id: EntityId, x: number, y: number, z: number, yaw?: number): void; give(item: ItemId, id?: EntityId): void; setMoney(id: EntityId, m: number): void;
  setInput(partial: Partial<InputCommand>, ticks?: number): void;        // overrides the sampled command for the next `ticks` ticks (default 1)
  state(): WorldState; snapshot(): RenderSnapshot; hash(): number; eventCount(kind: keyof SimEvents): number; events(kind: keyof SimEvents, last?: number): unknown[]; phase(): RoundPhase;
}
export interface PerfStats { frameMs: { avg: number; p95: number }; simMs: { avg: number; p95: number }; botMs: { avg: number; p95: number }; renderMs: { avg: number; p95: number }; drawCalls: number; triangles: number; heapMB: number; fps: number; quality: QualityPreset }   // globalThis.__cs.perf, rolling 5 s
```

---

## 12. Testing strategy

Tooling: **vitest** project `pure` (Node env) for every pure folder; project `dom` (**jsdom**) for `input/` and `ui/` logic; **Playwright** via `tools/e2e.mjs` (exists: headless Chromium with `--use-angle=swiftshader`, Pixel 5 landscape 851 × 393, `hasTouch`, scenarios in `tests/e2e/*.mjs`, `ctx.ready()` waits for `globalThis.__cs.ready`, `ctx.dbg(fn, …args)` calls `globalThis.__cs[fn]`); coverage gate 85 % lines on pure folders (`@vitest/coverage-v8`). Bench: `tests/bench/sim.bench.ts`. All of this tooling is set up by L1 on day 0 (§11.14).

### 12.1 Unit tests (what each module must assert)

| Module | Assertions |
|---|---|
| `core/math`, `rng` | vector ops; same seed → identical 1,000 draws; named streams independent; `gauss` mean/σ within 2 % over 10⁵; serialize/restore of `RngStreams` continues the sequence exactly |
| `core/loop` (fake clock) | 1.0 s → exactly 60 steps; a 500 ms stall → ≤ 4 steps then dropped time; `alpha ∈ [0,1)`; pause does not accumulate; `timeScale 4` → 4 steps/frame; `fpsCap 30` skips frames |
| `core/events` | order preserved; unsubscribe during dispatch safe; `guardReentrancy` throws on emit from a listener |
| `world/compile` | all §3.5 compiler assertions; ≈ 110 solids; `floorY` = 1.5 inside the platform; walk grid ≈ 1,150 walkable; ramp sub-cells flagged with wedge heights; `'training'` variant adds one `seal` solid per rect and fills `training`; `renderHints.solids.length == solids.length`; property test: random small grids never produce solids outside bounds or overlapping |
| `world/collision` (exists) + `movement` | wall slide keeps tangential speed; step-up 0.5 ✓, 0.6 ✗; ramp climb reaches 1.5 m; no tunnelling at 6 m/s; jump apex 0.90 ± 0.03 m; mounting a 1 m crate from a standing jump; crouch halves speed; can't un-crouch under 1.4 m; fall damage at 10 m/s = 10 HP; footstep events every 1.5 m while running, none while walking |
| `nav/navgraph` | §6.4 test list; chokepoint flags include all 10 listed chokes; hold spots snap to walkable nodes; stuck/blocked node re-plan yields a different path |
| `weapons/fire` | spread: crouch < stand < move; heat decays at the documented rate; recoil patterns length 30 / monotone first 8; after 30 AK shots `aimOffset` < 0.5° within 2 s; steady-state AK spray offset 7–11°; `sampleShotDir` inside the cone for 10⁴ samples; AK fires exactly 10 shots in 1 s held; semi-auto needs release; reload restores mag, decrements reserve, cancelled by switch |
| `weapons/hitscan`, `damage` | AK head + helmet at 10 m kills; AK body at 30 m = 34; Deagle head + helmet = 197; legs ignore armor; AWP legs 85; crate penetration ×0.6, wall none, AWP through `X` ×0.4; nearest player first; teammates ignored; `nearMiss` at < 1.5 m |
| `weapons/grenade` | bounce restitution; fuse ticks; HE 98 → 0 linear; LOS blocks; flash seconds vs angle table; self-damage on, teammates off |
| `rules/round` | FREEZE→LIVE after 300 ticks; buy window ends at tick 900; plant at 70 s → explode at 105 s = T `bomb`; defuse 7 s / 3.5 s kit; last T dead after plant continues; time win; half swap at round 5 (money 800, streaks 0); 5-5 → SUDDEN_DEATH; expiry → draw; TDM respawn 2 s, 30 kills ends |
| `rules/economy`, `buyPlan` | ladder 1,400…3,400; `max(0, streak − 1)` on win; planted-loss +800; planter +300; time-win survivors 0; cap 16,000; reject outside window/zone/money/team/max; helmet upgrade 350; `buyPlan` table rows; presets stop at the first unaffordable item |
| `ai/perception` | behind wall ✗; at 121° ✗; recognition delay; crouched target behind `~` ✗, standing ✓; hearing radii; confidence 0.5 never fires; blind disables |
| `ai/brain`, `combat` | FSM table with stubbed perception; carrier plants within 1.5 s when alone at the spot; CT defuses; ninja defuse at < 12 s; retreat at low HP; stuck → jump → re-plan; Hard time-to-first-shot ≈ 0.18 + 0.12 s; no NaN commands over 10⁴ fuzzed ticks |
| `ai/balance` (nightly, `tools/balance-sim.ts`) | 20 bot-only matches per difficulty (seeds 1–20) at headless speed: T win-rate 40–60 %, mean round 35–70 s, plant rate ≥ 35 %, no round without movement, no exceptions |
| `sim` | **golden**: 3 rounds, seed 42, scripted command log → `hash()` equals `tests/golden/depot-seed42.json` (regenerated only via `npm run golden:update` on the pinned Node, §11.10); `restore(serialize())` + 600 ticks == continuous; two sims, same seed and commands → identical hashes after 10⁴ ticks; `writeSnapshot` allocation-free: every nested object/array of the snapshot is `Object.is`-identical before and after 600 calls, no key is added, and (when run with `--expose-gc`) `heapUsed` grows < 64 KB after `gc()`; death pipeline: a kill credits reward/stats, drops primary + bomb, clears the assignment, emits exactly one `death`; bot `onEvent` receives every envelope of the tick in order; `freezeBots(true)` → bot commands equal `IDLE_COMMAND` |
| `input/aimAssist`, `touch` (jsdom) | identity when Off or occluded; friction factors inside radii; magnetism ≤ 1.5°/s at Medium, only while dragging; joystick dead zone / walk band; pointer ownership (button beats joystick zone; Fire-R contributes look; joystick never does); sub-tick tap latched into one FIRE tick |
| `ui/buyMenu`, `i18n` | affordability, max grenades, team locks, preset = `buyPlan`; every key in zh has en and vice versa; no unresolved `{param}` |
| `render/textures`, `viewmodel` (node) | recipes are deterministic: `paintTexture(id, size, rng, fakeCtx)` with a fake `Ctx2D` that records the call list; its hash matches a stored value; viewmodel springs converge; bob amplitude bounds |
| `audio/recipes` | every recipe yields finite samples, peak ≤ 1.0, length within spec |
| Architecture | pure folders import no `three`/DOM; `tsconfig.sim.json` type-checks without `DOM` lib |

### 12.2 Playwright scenarios (`tests/e2e/*.mjs`, `?seed=1&test=1` merges the `TestHooks` of §11.16 into `globalThis.__cs`)

| Scenario | Steps / assertions |
|---|---|
| Boot & PWA | loads; canvas present; WebGL2 acquired; no console errors; `navigator.serviceWorker.ready`; `context.setOffline(true)` → reload succeeds; locale zh for `zh-CN`, EN toggle changes the Play button text |
| Onboarding | first launch → training; joystick touch (press (15 %, 70 %), move +60 px, hold 2 s) → player x ≥ 5 m; hit 5 targets with `give('ak47')` + tap-to-fire |
| Touch look & fire | drag 200 px on the right half → yaw ≈ 200 × 0.176° (±5 %); tap Fire-R → `shots` = 1; hold 1 s with AK → 10; Fire-R drag rotates the view |
| Buy flow | Defusal, FREEZE: tap 购买, tap AK with $800 → denied toast; Deagle → money 100 and active weapon deagle; after tick 900 → `window` error |
| Round flow | `freezeBots(true)`, `teleport(1, A spot)`, `give('c4')`, `resume()`, hold the Use pill 3 s → `state().bomb.state == 'planted'`, timer bar visible; `stepTicks(35 × 60)` → T-win banner, score 1:0, money delta list |
| Full match smoke | `startMatch({ seed })`, human idle, `stepTicks(600)` in a loop until `phase() == 'MATCH_END'` (synchronous batch stepping: a 10-minute match is ≈ 36 k ticks ≈ 10 s under SwiftShader, so 90 s wall is a hard cap); **3 seeds per CI run** (the 60-match sweep is the nightly Node `balance-sim`); no exceptions; stats persisted |
| Pause / back | `window.__csBack()` returns `'handled'` → pause overlay, tick count frozen; `dispatchEvent(new Event('cs-pause'))` pauses; resume continues; on the main menu `__csBack()` returns `'none'` |
| Settings persistence | set sens 12 + EN + Low; reload → restored; HUD labels English |
| Orientation gate | viewport 393 × 851 → rotate overlay; back to landscape → hidden |
| Desktop | `--desktop` profile: WASD moves, pointer lock requested on click, mouse look |
| Visual | DOM-only screenshots of main menu, settings and buy menu (canvas hidden) with a 5 % threshold; no WebGL screenshot comparisons (SwiftShader output is not stable across Chromium versions) |

### 12.3 Performance checks

- `globalThis.__cs.perf` (`PerfStats`, §11.16, computed by `app/perf.ts`): rolling 5 s histograms of frame ms (avg/p95), `sim.step` ms, bot think ms, `renderer.render` ms, draw calls, triangles, JS heap; the same histogram drives Auto quality stepping (§10.3).
- Playwright perf spec (CPU-side only under SwiftShader): a 20 s scripted 5v5 firefight on Medium → `sim.step` p95 < 3 ms, bots < 1.5 ms/tick, `render` sync p95 < 3 ms, draw calls ≤ 60, triangles ≤ 80 k, heap growth over 60 s < 10 MB.
- Bench gate (`tests/bench/sim.bench.ts`, CI): 10,000 ticks of 5v5 Hard in < 2.5 s (≈ 0.25 ms/tick; phone budget 2 ms).
- Manual device matrix (release checklist): 2020 mid-range (Snapdragon 720G / Dimensity 800), a 2021 flagship, a 2019 low-end; 5-round match on Medium ≥ 58 fps avg / ≥ 45 fps 1 %-low; Auto settles within 15 s; battery ≤ 9 % per 20 min (saver ≤ 5 %); cold start to menu ≤ 2.5 s (textures + audio bank measured with `performance.mark`).

---

## 13. Risks & mitigations

| # | Risk | L / I | Mitigation |
|---|---|---|---|
| 1 | WebView GPU variance (Mali/Adreno/PowerVR): shader compile hitches, WebGL2 missing on very old devices | H / H | Lambert/Phong only, `renderer.compile()` behind the loading screen; **WebGL2 required** (Three r16x+ dropped WebGL1) — missing → a 「设备不支持 / Unsupported device」 card instead of a black screen; no shadow maps; DPR cap 1.5; merged map geometry; Auto preset |
| 2 | 60 fps missed on the target phone | H / H | Frame budgets in §10.3 enforced by the CI perf spec and the bench gate; particle/decal/tracer pools per preset; HUD DOM at 20 Hz; `writeSnapshot` allocation-free |
| 3 | Touch latency / multi-touch conflicts | M / H | Pointer ownership rules (§7.2) unit-tested in jsdom; look preview on the render frame; sub-tick latching; `touch-action: none`; `pointerrawupdate` |
| 4 | Aim assist feels like cheating or absent | M / M | Four levels, body-only, drag-gated magnetism, same function for tick and preview; onboarding asks; bots unaffected so results are honest |
| 5 | Recoil unlearnable on touch | M / M | Half-strength view kick + recoil crosshair + τ 0.45 s so pull-down is visible and rewarded; 60 % pattern amplitude; tests pin the steady-state offset |
| 6 | Bots look dumb (stuck, staring, never plant) or cheat | H / H | 1 m nav grid + string pulling + stuck detector; authored hold spots; LOS-only perception with a single recognition delay; confidence-0.5 hearing never fires; nightly balance suite with plant-rate; `botState` debug overlay; difficulty is data |
| 7 | Determinism broken (RNG, iteration order, DOM time) | M / H | Named streams inside state; id-ordered iteration; tsconfig without DOM + lint; golden hash on every PR; restore-equals-continuous test |
| 8 | Integration across 8 lanes | H / H | Frozen `sim/state.ts`, `sim/events.ts`, `InputCommand`, `RenderSnapshot`, `CompiledMap`, `BotBrain`; runnable stubs day 0; integration lead owns `app/`; daily merges; `npm run check` is the merge gate |
| 9 | Session length too long for phones | M / M | 5 s freeze, 75 s rounds, first-to-6, skip-round at 4×, continue-match snapshot at FREEZE |
| 10 | HUD unreadable / notch overlap / controls under the thumb | M / H | 14 px minimum with outlines; safe-area + cutout vars; inert top-left band for HP/money (outside the joystick zone); layout editor; DOM screenshot tests at 851 × 393 |
| 11 | Audio autoplay / WebView latency (100–200 ms) | H / L | Unlock on the Play tap; pre-rendered buffers; `latencyHint: 'interactive'`; flash + haptic never wait for audio |
| 12 | Memory (textures, audio, views, decals) | M / M | ≤ 16 RGB textures at 512² (≈ 21 MB with mipmaps), audio ≈ 2 MB, ring buffers, views disposed on id loss, 24 voices, heap-growth e2e check; killed WebView resumes from `cs.v1.match` |
| 13 | Service worker serves a stale build / updates mid-match | M / L | Content-hashed precache list stamped by `tools/build.mjs`; update toast only on the main menu; the APK ships assets and never needs the SW |
| 14 | Android back / lifecycle | H / L | Back → existing `window.__csBack()` → pause or close menu (returns `'handled'`), `'exit'` only from the main menu after a double press; `cs-pause` → pause + suspend audio; `cs-resume` → pause menu |
| 15 | Gyro API differences | M / L | Optional; bridge forwards `SensorManager` rotation at 100 Hz in the app, `DeviceOrientation` in browsers; feature-detected, hidden otherwise |
| 16 | Procedural art looks cheap | M / M | Noise + grime + stencils + stripes; vertex AO; dressing props; corrugated bands; fog; a final art pass budgeted at 20 % of L6 |
| 17 | Scope creep | H / M | §1.2 is binding; new weapons/maps/difficulties are data; smokes stay out |
| 18 | Flash overlay annoying on small screens | L / M | Max 3.0 s, strong angle/distance falloff, ring fades; Easy bots never throw flashes |

---

## 14. Build & packaging

### 14.1 Repository layout (matches the existing scaffold)

```
cs-android/
├─ package.json                 # existing scripts dev, build, typecheck, test, e2e, build:android, build:apk, check + L1 day 0 adds lint, test:dom, bench, size, golden:update (§11.14)
├─ .nvmrc (22) · tsconfig.json (DOM) · tsconfig.sim.json (lib ES2022, no DOM: core, world, maps, nav, weapons, rules, ai, sim, i18n, settings) · eslint.config.js   # the last two are new (L1 day 0)
├─ vitest.config.ts             # extended to projects: "pure" (node) and "dom" (jsdom: input, ui) — L1 day 0
├─ web/                         # static shell: index.html (<canvas id="gl">, <div id="ui">, inline critical CSS, viewport-fit=cover), sw.js, manifest.webmanifest
├─ src/
│  ├─ main.ts                   # entry: boot app/game.ts
│  ├─ core/        math.ts rng.ts events.ts loop.ts                      (exist)
│  ├─ settings/    types.ts                                               (shared Settings/TouchLayout types, L1)
│  ├─ sim/         state.ts events.ts brain.ts entities.ts  |  candidates.ts death.ts sim.ts   (types | facade)
│  ├─ world/       types.ts compile.ts collision.ts movement.ts
│  ├─ maps/        depot.ts box.ts
│  ├─ nav/         navgraph.ts
│  ├─ weapons/     defs.ts patterns.ts fire.ts hitscan.ts damage.ts grenade.ts inventory.ts items.ts
│  ├─ rules/       round.ts economy.ts buyPlan.ts bomb.ts match.ts modes/{defusal,tdm,training}.ts
│  ├─ ai/          brain.ts perception.ts strategy.ts combat.ts steer.ts difficulty.ts names.ts
│  ├─ i18n/        i18n.ts (exists) zh.ts en.ts
│  ├─ render/      renderer.ts quality.ts cameraRig.ts mapMesh.ts dressing.ts viewmodel.ts radar.ts textures/*.ts models/*.ts effects/*.ts
│  ├─ input/       inputSystem.ts touch.ts joystick.ts keyboard.ts gyro.ts aimAssist.ts layout.ts
│  ├─ audio/       dsp.ts (exists) recipes.ts bank.ts engine.ts
│  ├─ ui/          dom.ts hud.ts crosshair.ts buyMenu.ts layoutEditor.ts settings.ts onboarding.ts screens/*.ts styles.css
│  ├─ app/         game.ts matchSettings.ts stats.ts testHooks.ts perf.ts
│  └─ platform/    persist.ts (moved from app/) android.ts (moved from app/bridge.ts) pwa.ts haptics.ts
├─ tests/
│  ├─ unit/        mirrors src/ (*.test.ts)  · golden/depot-seed42.json  · fixtures/
│  ├─ bench/       sim.bench.ts
│  └─ e2e/         *.mjs scenarios for tools/e2e.mjs  · screenshots/ baselines
├─ tools/          build.mjs (esbuild + stamping) · serve.mjs · e2e.mjs · png.mjs (dependency-free PNG encoder for icons) · sync-android.mjs · nav-dump.ts · balance-sim.ts · size.mjs · apk/ (SDK-free pipeline)
├─ android/        Gradle project (exists): app/src/main/{AndroidManifest.xml, java/com/csandroid/strike/{MainActivity,NativeBridge}.kt, res/, assets/www/ (synced from dist/)}
└─ .github/workflows/ci.yml   (new, L1 day 0)
```

### 14.2 esbuild (`tools/build.mjs`, exists; target behaviour)

- As the existing script does: `bundle: true, format: 'iife', target: ['es2020', 'chrome90'], platform: 'browser', minify` in prod, `sourcemap: 'inline'` in dev, `treeShaking: true`, `legalComments: 'none'`, `define: { __DEV__, __VERSION__ (package.json version) }`; entry `src/main.ts` → `dist/app.js`; `metafile` written for the size report (`tools/size.mjs`, new). The IIFE format is kept deliberately (one classic `<script>`, no module-script quirks in old WebViews). The service worker stays a hand-written classic script (`web/sw.js`, no module SW).
- Post-build (exists): copy `web/` → `dist/`, generate icons with `tools/png.mjs` (192/512 + maskable, no native deps), compute a **content hash of every output file**, stamp it into `sw.js` (`__BUILD_VERSION__`, `"__PRECACHE__"` list) and `index.html` (`app.js?v=HASH`). No `Date.now()`, no `git` in the build → reproducible.
- Three.js: `import { … } from 'three'` and `BufferGeometryUtils` from `three/examples/jsm/utils/BufferGeometryUtils.js` — one package entry, tree-shaken by esbuild (≈ 450 KB min / ≈ 120 KB gz). App code ≈ 250 KB min / ≈ 70 KB gz. **Size gate (`npm run size`): `app.js` ≤ 900 KB minified and ≤ 300 KB gzip**; typical ≈ 700 / 190 KB.
- Dev: `esbuild.context().watch()` + `tools/serve.mjs` on `:8080` with the LAN URL printed for phone testing; `npm run dev -- --https` uses a self-signed cert so the service worker and gyro work over the LAN.

### 14.3 PWA

`manifest.webmanifest`: `name` "弹壳 Shell", `short_name` "弹壳", `start_url` "./?source=pwa", `scope` "./", `display` "fullscreen", `orientation` "landscape", `background_color`/`theme_color` "#1c1e22", `lang` "zh-CN", icons 192/512 + maskable. `index.html`: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">`, `html, body { overscroll-behavior: none; touch-action: none; background: #1c1e22 }`.

`web/sw.js` (exists): cache `cs-strike-<hash>`; `install` → `cache.addAll(precache)` + `skipWaiting`; `activate` → delete other caches + `clients.claim`; `fetch` → cache-first for same-origin GET, navigations resolve to `index.html`. The app registers it in `platform/pwa.ts`; a **waiting** worker shows the update toast only on the main menu; applying = `postMessage('SKIP_WAITING')` + reload. `screen.orientation.lock('landscape')` and `requestFullscreen()` are attempted on the Play tap (failures ignored); `navigator.storage.persist()` requested once.

### 14.4 Android WebView wrapper (Kotlin, minSdk 26, targetSdk 34, ≈ 300 lines, no game logic)

| Concern | Implementation |
|---|---|
| Assets | `dist/` synced to `assets/www/` by `tools/sync-android.mjs`; served by `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/www/index.html` (secure origin → `localStorage`, vibration, orientation, SW all work); no `file://` |
| WebView settings | `javaScriptEnabled`, `domStorageEnabled`, `mediaPlaybackRequiresUserGesture = false`, `allowFileAccess = false`, `mixedContentMode = NEVER_ALLOW`, `setSupportZoom(false)`, `overScrollMode = NEVER`, `setLayerType(LAYER_TYPE_HARDWARE)`, long-press/selection disabled, `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` |
| Orientation | manifest `android:screenOrientation="sensorLandscape"`, `configChanges="orientation|screenSize|keyboardHidden|screenLayout|uiMode"`, `resizeableActivity="false"` |
| Immersive | `WindowCompat.setDecorFitsSystemWindows(window, false)`; `WindowInsetsControllerCompat.hide(systemBars())` with `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`, re-applied in `onWindowFocusChanged`; `layoutInDisplayCutoutMode = SHORT_EDGES`; `FLAG_KEEP_SCREEN_ON` during a match |
| JS bridge `window.CSNative` (`@JavascriptInterface`, **exists** in `NativeBridge.kt`, frozen) | `platform(): "android"`, `version(): String`, `vibrate(ms: Int, amplitude: Int)`, `cancelVibration()`, `exit()`. Nothing else is needed: immersive mode, `FLAG_KEEP_SCREEN_ON` and audio focus (`AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` in `onResume`, abandoned in `onPause`) are handled by the activity itself; safe insets come from CSS `env(safe-area-inset-*)` (`viewport-fit=cover` + `SHORT_EDGES`); the gyro uses the web `Gyroscope`/`deviceorientation` APIs (secure `appassets` origin, §7.4); the API 31 splash dismisses on first draw. `platform/android.ts` (the existing `bridge`) falls back to `navigator.vibrate` in browsers |
| Back button | **exists:** `onBackPressed` → `evaluateJavascript("window.__csBack ? String(window.__csBack()) : 'none'")`; `'handled'` = the page closed a menu or opened pause; `'exit'` = finish; `'none'` = the activity dispatches the DOM event `cs-back` and shows 「再按一次退出」, finishing on a second press within 2 s |
| Lifecycle | **exists:** `onPause` → `webView.onPause(); pauseTimers();` + DOM event `cs-pause`; `onResume` → the reverse + `cs-resume` (the page lands on the pause menu, never straight into gameplay); `onDestroy` → `webView.destroy()` |
| Manifest / release | permissions: `VIBRATE` only (**no INTERNET** — proves zero downloads); `hardwareAccelerated="true"`, `allowBackup="false"`; theme background `#1c1e22` (no white flash); `SplashScreen` API with the generated icon; R8 `minifyEnabled`; APK ≈ 2–3 MB. `tools/apk/` provides the SDK-free packaging path; Gradle `assembleRelease` is the standard path |

### 14.5 CI (`.github/workflows/ci.yml`)

New file, written by L1 on day 0. Node from `.nvmrc` (22): `npm ci` → `typecheck` (both tsconfigs) → `lint` → `vitest run --coverage` (projects `pure` + `dom`; pure ≥ 85 %) → `bench` gate → `build` → `size` gate → `e2e` (Playwright, SwiftShader, Pixel 5 landscape + desktop profile; 3-seed full-match smoke; screenshots and console logs uploaded on failure) → `android/gradlew assembleDebug` (Java 17, cached) on `main` and tags. Nightly: `tools/balance-sim.ts` (60 bot matches) posts the win-rate / round-length / plant-rate table. Tags `v*` upload `dist/` (PWA) and the APK as release artefacts.


---

## 15. Implementation status & deviations (as built)

The game is implemented end to end: all §11 lanes are integrated, the gate (`npm run check`) is green, and a full
match plays to `MATCH_END` in the Playwright phone profile (`tests/e2e/090-full-match.mjs`). The table lists where
the shipped code deliberately deviates from the sections above, with the reason; everything else follows the text.

| Area | Spec | As built | Why |
|---|---|---|---|
| §3.5 solids / walk grid | ≈ 110 solids, ≈ 1,150 nodes | 66 solids (walls merge into 27 boxes), 1,132 walkable sub-cells | wall merging is better than estimated; counts measured by `tests/unit/world` |
| §6.4 route lengths | T→A 44 ± 5, CT→A 14 ± 3, A→B 31 ± 4 m | 39.3 / 14.2 / 29.1 m (T→B 43.5, CT→B 15.9) | measured over pulled corners on the real map |
| §2.1 jump / crates | apex 0.90 m, 1 m crates mountable | exact 0.900 m; airborne step-up added so a standing jump mounts a crate; sandbags (1.2 m) are mountable too; wall/lintel/seal tops are never walkable | playability + no roof exploits |
| §3.4 low walls | "block crouched targets" | cover class: ≥ 1.8 m counts as full cover (the 1.9 m lip is full cover from Long) | matches the lip's purpose |
| §4.1 penetration | AWP through `X` ×0.4; props ≤ 1.2 m thick | factor = min(weapon, prop); tall crates (2 m cubes) are penetrable by the AWP up to 3.0 m thickness | the 1.2 m rule would make the AWP exception meaningless |
| §4.4 dry fire | — | dry fire never starts a reload in the sim; auto-reload is an input-layer setting (§7.5) | keeps the sim command-driven |
| §4.4 knife | 60° cone | ±30° cone; knife damage is flat, never a headshot, not counted in shots/hits | hit feedback consistency |
| §2.2 plant/defuse interruption | "damage interrupts" (bots, §6.8) | human progress is NOT interrupted by damage (CS rule); it resets on release/moving; bots release USE themselves | follows §2.2 literally |
| §2.2 MVP | most kills this round, tie by kill tick | alive winner with the most match kills, ties lowest id | `PlayerState`/`RoundState` are frozen; no per-round kill tally field |
| §2.2 half | swap sides | each player's `team` field swaps (and `cfg.humanTeam`), scores swap with the teams, a 5 s FREEZE precedes sudden death | simplest serialisable swap |
| §2.3 TDM / §2.4 training | round end | end straight to `MATCH_END` (`roundEnd` + `matchEnd` in one tick); training human respawns after 2 s; training always spawns on the T side (the sealed region is the T side) | spec diagram |
| §5 armour | — | helmet upgrade $350 only adds the helmet; Kevlar+Helmet with armour < 100 refills for $650; buying a new primary in defusal drops the old one as a world item | CS rules |
| §6.6 recoil control | pitch −= rc·0.5·offset per tick | the aim target subtracts rc·offset (the exponential tracker over-compensated 2–3× otherwise) | measured |
| §6.6 fire cone | angle to chest | angle to the nearer of chest/head (otherwise Hard bots aiming at heads inside 13 m never fire) | geometry |
| §6 engage range (new) | — | pistols/MP5 30 m, Deagle 40 m, rifles 65 m, AWP 90 m; disengage at 1.25×; no ENGAGE during FREEZE | stops spawn-to-spawn pistol duels |
| §6.5 lanes | shortest path | main group routes via the Long door (A) / Tunnel door (B); the lurker holds the connector | plain shortest path sent the B attack through the lurker's spot |
| §8.1 crosshair offset | dx with aspect⁻¹ | dx = −tan(½·aimOffsetYaw)/tan(fov/2)·H/2 (vertical FOV, +yaw = left per §0) | matches the renderer's convention |
| §8.1 text | 13 px kill feed | 14 px minimum everywhere; score row under the timer | readability |
| §10 renderer | per-material door/lintel/ceiling, world-metre crate UVs, hip tip-over, orbit 6 m | shared metal/concrete tints (8 static draw calls), 0–1 UVs per crate face, corpses pivot near the floor, blob shadow shrinks, menu orbit 3.9 m (ceiling 4.5), light intensities ×2.7 (three r186 physical lights), recoil kick clamped at 3, kill-cam 1.8 s then spectate, map perimeter clad to the ceiling | measured draw calls 21 in match / 31 with effects, 9–10 k triangles |
| §9 audio | ≈ 2.3 MB bank | 72 buffers, 2.67 MB (float32); own impacts/explosions stay positioned; `radio_rotate` has no trigger | — |
| §7.2 touch layer | element hit-testing | purely visual overlay; ownership decided by coordinates in window-level listeners (3 vh margins, nearest centre, Fire-R edge extension) | expressible only this way |
| §14.2 size gate | ≤ 900 KB min | ≤ 1024 KB min (gzip limit 300 KB kept; shipped 928 KB / 264 KB) | Three.js + 15 k lines of app code |
| §11.4 `PlayerState` | — | gained `prevButtons` and `rescope` (press edges, AWP zoom memory) | formalised from the weapons lane |
| §11.8 `Simulation.step` | — | step 6 also calls `rules/bomb.applyUseIntent(p, cmd, …)` per alive player; humans without auto-pickup use `weapons/items.pickupObjectives` (bomb/kit only) | plant/defuse/pick-up intent |
| §6.5 CT rotation call | confidence-1 sighting inside a site | also ≥ 2 distinct enemies seen (confidence 1, within 5 s) in the lanes that lead to one site only (Long / A ramp / A connector → A, Tunnel / B door / B connector → B); Mid never calls | a stacked execute is called while it is still in the lane, not when the holders are already dying (T win 67 % → 60 % on Normal) |
| §6.7 Hard counter-strafe | stop before firing | full opposite input only while speed > max(0.3 m/s, ½ ground-accel step); below that the bot coasts on friction | a full-input brake bounced 0.30 → 0.37 → 0.30 m/s forever (measured), so Hard bots almost never "settled": fixed, Hard T win 39 % → 60 % |
| §12.1 `ai/balance` harness | human idles at spawn | the human slot is bot-driven (full 5v5); `--idle-human` keeps the old mode | an idle T may hold the bomb and CTs camp an idle last T, which inflated CT time wins (40 % of Hard rounds) |

Measured balance (12 bot-only matches per difficulty, 5v5, first to 6, `npm run balance`): Easy T 40 % / 42 s rounds /
54 % plants; Normal T 64 % / 46 s / 69 %; Hard T 27 % / 54 s / 38 % (40 % of Hard rounds end on time). Easy is on
target; Normal and Hard are tuned in the polish pass (knobs in `src/ai/{combat,brain,strategy,difficulty}.ts`).

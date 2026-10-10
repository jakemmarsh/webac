# Performance Budgets

Standing parameter of the iteration loop (Jake, 2026-08-23): "this is an old,
arguably ugly game — we should aim for pretty high performance benchmarks."

## The covenant: fidelity is not a performance lever

**No shortcut that sacrifices game fidelity or UX is a valid perf fix.**
Forbidden moves: removing/simplifying DAT-mandated visuals or effects, reducing
draw distance below retail, skipping animation/particle work, debouncing or
coalescing UI updates in ways a player could notice, lowering texture
resolution, culling that pops visibly. Perf fixes must be *transparent*:
batching, caching, pooling, async/off-thread work, algorithmic fixes. Every
perf change passes the SAME live visual verification + side-by-side as any
visual change — if the screenshots differ, it's not a perf fix, it's a
regression. If a genuine fidelity/perf tradeoff ever seems necessary, file it
with evidence and STOP — Jake decides.

## Bars

**Real GPU (the actual bar, measured on the dev machine, visible tab):**
- Sustained 60 fps in normal play: frame p95 ≤ 16.7ms (idle/turning/running)
- Zero >100ms hitches in steady-state play; landblock-streaming hitches ≤ 50ms
- Portal transitions/login exempt from the hitch bar but must not grow

**Cloud (SwiftShader — FPS is meaningless there; these are the comparable
scene-cost budgets, from `tools/measure-perf.ts` render metrics):**
- Draw calls per frame: TARGET < 1,500 (stretch 800). Ratchet: never regress >10%.
  **TARGET MET 2026-09-07** (perf-2026-09-07T19-14-38-989Z.json): phase means
  736 idle / 1,176 turning / 644 running after the PERF.1 cross-landblock
  overlay pool (OverlayMergePool) — down from 13,559/16,463/15,368 at the
  2026-08-23 baseline (−92–96%). Stretch met at idle+running. Cross-run
  ratchet caveat: a same-code back-to-back run flagged +60% idle draw calls
  that decomposed entirely into +706 dynamic `part` meshes (server creature
  spawns accumulate while sessions keep Holtburg blocks active) plus two
  extra streamed landblocks — when the ratchet flags a regression, check the
  census `part`/`envcell` rows before blaming renderer code; the
  code-attributable delta lives in the deterministic static-mesh categories
  (blendmerge/roadmerge/sceneryinst/staticinst/bldginst) and in same-session
  point samples.
- Triangles: < 1.5M. Since 2026-09-07 the steady-state sits at ~1.03–1.06M:
  the PERF.1 cross-landblock scenery/statics pool (SceneryInstancePool) trades
  per-landblock frustum culling for one InstancedMesh per distinct
  (GfxObj, submesh) region-wide, so off-frustum instances are submitted
  (vertex-stage only, zero visible pixels) instead of culled. Accepted
  deliberately: draw calls fell 33–45% and renderJs p50 fell ~58% in the same
  run, and the count is heading-invariant. Don't "fix" the triangle number by
  re-chunking scenery without re-measuring renderJs; the submission win
  dominates on both renderers. (In-frustum scenery draws 2× per frame — the
  three.js double-sided-transparent two-pass on canopy materials — which
  inflates both calls and triangles equally on every run; pre-existing,
  renderer-level, applies to any A/B symmetrically.)
- Geometry count: `renderer.info.memory.geometries` is a CUMULATIVE memory
  counter (BufferGeometries with GPU buffers allocated), not a per-frame
  cost. three.js uploads buffers lazily on first render, so the counter
  GROWS on the first full camera sweep as off-heading meshes get first-drawn,
  then plateaus — idle→turning growth alone is NOT churn or a leak.
  Measured (PERF.2 probe, 2026-09-07, tools/perf2-probe.ts at Holtburg):
  12+ revolutions grew geometries 1243→2101 with the scene-graph mesh count
  exactly flat (4,679) and ZERO BufferGeometry.dispose calls; revolutions
  after the first sweep added nothing. Textures (391→560) and shader
  programs (81→155) behave the same way (lazy upload / lazy compile).
  The travel-leak half is likewise disproved (tools/perf2-leak-probe.ts,
  2026-09-07): settled+swept geometries went Holtburg 1,875 → Eastham 1,460
  (Holtburg's buffers disposed on unload while Eastham's uploaded) → back to
  Holtburg 1,759 — full recovery, slightly BELOW the original plateau.
  Textures do NOT recover (479→530→530): MaterialFactory's cache is
  deliberately never disposed — bounded by distinct materials seen, not a
  leak. The actual churn/leak signals to gate on: continued geometry growth
  across REPEATED sweeps of the same scene, nonzero dispose counts while
  stationary, or a post-travel return to a settled+swept spot far above its
  prior plateau. The per-phase ratchet comparison (same phase vs same phase
  at the same location) stays valid.
- JS frame-integration cost + hitch counts: ratchet, never regress >10%.

## Baseline (2026-08-23, SwiftShader, spawn area — the "before" picture)

| phase | drawCalls | triangles | geometries | textures |
|---|---|---|---|---|
| idle | 13,559 | 523k | 7,572 | 241 |
| turning | 16,463 | 337k | 22,106 | 464 |
| running | 15,368 | 310k | 22,126 | 474 |

Two filed findings fall straight out of this baseline:
- **PERF.1** draw calls are ~10x over budget — per-part/per-object meshes with
  no static batching. This is THE bottleneck: ~15k calls ≈ 30-60ms/frame of
  CPU submission overhead on any GPU. Fix shape: merge/instance static
  landblock+scenery geometry by material, texture atlas where the DAT permits
  — visually identical output (covenant applies).
- **PERF.2** geometry count triples on first camera turn and stays — rebuild
  churn or leak in landblock/scenery/EnvCell paths. (RESOLVED 2026-09-07:
  neither — lazy first-render GPU upload of already-loaded meshes; see the
  geometry-count bullet above for the probe evidence.)

## Real-GPU check (2026-08-29, Jake's machine, Holtburg, visible tab)

**11 fps.** `renderer.info`: 10,704 draw calls, 503k triangles, 23,329
meshes, **0 InstancedMesh**, 13,728 geometries. Census by named ancestor:
`part_N` scenery parts 19,681 (8,534 beyond 600 m, 15.5k beyond 300 m —
no scenery distance cull, camera.far=2000); `envcell_#` 1,305 interior-cell
meshes with 829 beyond 600 m drawn while outdoors; `physcoll_#` 444
collision proxies in the render scene. Jake's verdict: "performance seems a
little lacking." This is PERF.1 / CORE.14 felt live.

Why the ratchet never said so: every cloud run is SwiftShader at ~0.4 fps,
so "no regression" only ever meant "draw calls didn't climb" — and ~12.5k
was the accepted baseline from the first run. The harness now records four
things that DO track the real bottleneck across renderers (see
`tools/measure-perf.ts` header): `location`, `census`, `renderJs` (JS-side
`renderer.render()` time — submission cost, not rasterization), and
`estimatedRealGpu` (draw calls × `REAL_GPU_US_PER_DRAW_CALL` = 8.5 µs,
calibrated from this run; re-calibrate and date it when the scenery pipeline
changes shape). Sanity check the same day: a local SwiftShader (LLVM) run at
the same spot reported `renderJs` p50 = 98.7 ms idle against the real GPU's
91 ms whole-frame — the JS submission cost really is the frame, on either
renderer. `--ratchet` makes the comparison mechanical: latest
same-renderer + same-location run, >10% worse on draw calls / geometries /
triangles / renderJs p50 → exit 2. Between real-GPU runs it additionally
ratchets measured avgFps (>10% drop) and hitch100 (up by more than 2);
those two are skipped between software-renderer runs — on SwiftShader every
frame is >100ms, so hitch100 ≡ frames sampled and a FASTER run (more frames
per phase) false-flagged as a hitch regression on 2026-09-04.

## Real-GPU check (2026-09-26, Jake's Mac, `--gpu` headless, Holtburg)

`measure-perf.ts --gpu` runs HEADLESS on the real GPU. Playwright's `chromium`
channel is Chrome's new headless mode, which on macOS renders through ANGLE
Metal and reports "Apple M3 Max". The default headless shell is SwiftShader.
No window and no visible-tab requirement, and it works from inside the Claude
harness, unlike `--headed`. Exits 3 rather than record a software run.

| Landscape Draw Distance | avgFps idle / turning / running | draw calls idle / turn / run | triangles (idle) | renderJs p50 idle | worst frame |
|---|---|---|---|---|---|
| 3 (the shipped interim default) | 120 / 108.7 / 119 (vsync cap) | 421 / 580 / 431 | 59k | 3.6 ms | 375 ms (turning) |
| **8 (retail default, Medium)** | **76.8 / 67.1 / 70.7** | **806 / 950 / 788** | 106k | 6.5 ms | 258 ms (turning) |

JSON: `verification/perf/perf-2026-09-26T18-05-22-587Z.json` (3) and
`perf-2026-09-26T18-07-38-485Z.json` (8). Since 2026-08-29 (11 fps, 10,704 draw
calls) the CORE.14/PERF work cut submission ~13×. Retail's default 8 now clears
the 60 fps bar and the draw-call/triangle budgets on this machine, which is the
tradeoff CORE.17.h.g.a.a was waiting on (it is Jake's call). The M3 Max is
high-end, so a mid-range GPU has less headroom. The turning phase still logs
2–3 frames over 100 ms at either radius: the first-look shader-compile /
upload stall PERF.4 predicted, now confirmed on real hardware.

`--draw-distance N` seeds the Options value before load (an integer 1..25,
retail's menu range; anything else exits 1; ignored with a warning under
`--attach`). Runs record
`landscapeDrawDistance`, and the ratchet never compares across radii (absent
= the shipped 3).

**Nightly real-GPU run:** `tools/local-gpu-perf.sh` (launchd, 04:10 local,
installed by `tools/install-local-gpu-perf.sh`; `--uninstall` removes it). It
checks origin/main out in a private worktree, brings up Docker/ACE/bridge/Vite
as needed, runs `measure-perf --gpu --ratchet`, and pushes the JSON (renderer
string "ANGLE Metal … Apple M3 Max"). **Cloud cycles:** the latest such JSON is
the real-GPU reference. Quote it next to your SwiftShader scene costs, and treat
an fps or hitch drop between two consecutive nightly runs as a PERF finding
(the ratchet already flags it on real-GPU pairs). Log: `~/Library/Logs/acjs/gpu-perf.log`.

Safety (2026-09-26): ACE boots an in-use session on a new login
(`account_login_boots_in_use`, default true), so the job SKIPS (exit 0, logged)
while any client is connected through the bridge on :9090. It checks at start
and again just before measuring. It commits only when measure-perf exits 0. A
regression (exit 2) or failure goes to `~/Library/Logs/acjs/gpu-perf-quarantine/`
and is never committed. Every `--ratchet` JSON records `ratchetVerdict`, and
`findBaseline` never uses a `regression` run as a baseline. A push that fails
three times leaves the commit on a local `gpu-perf-unpushed-<utc>` branch and
logs it; the job never drops it silently.

## PERF.3 / PERF.5 — landblock content census (2026-09-26, node, real DATs)

`npx tsx tools/landblock-content-census.ts [0xXXYY …] [--radius N]` drives the
shipped `LandblockObjectStreamer` over the EoL cell/portal DATs (mesh builders
counted, physics models null) — no browser. Draw distance 8:

| spot | before: cell meshes / physcoll proxies / cell collision | after: cell meshes / cell collision | before: statics / buildings / scenery instances | after (drawn) |
|---|---|---|---|---|
| Holtburg 0xA9B4 | 665 / 665 / 665 | 197 / 197 (25 blocks built, 9 drawn) | 787 / 60 / 32,066 | 223 / 16 / 383 |
| sparring-golem area 0x0366 | 18,886 / 18,886 / 18,886 | 0 / 0 | 0 / 0 / 217 | 0 / 0 / 11 |

Not a covenant trade: retail itself instantiates objects only on the 3×3
full-detail blocks (docs/retail-client-symbols.md "Objects exist only on the
3×3 full-detail blocks"); interior cells beyond the building stab sets build
on the player's PVS demand, exactly when the surface rule can show them.

## First-look hitch: program-key churn (PERF.4, 2026-09-27, M3 Max `--gpu`, Holtburg, radius 8)

`measure-perf --program-keys` stores every live WebGLProgram's `cacheKey`
after settle / idle / turning / running (`result.programKeys`). Diffing the
keys a phase adds against the idle set showed the turning phase's new
programs differed from existing ones in exactly ONE field: index 34 of the
key, `numPointLights`. DatLightBudget's enabled count follows cell
visibility, so a camera turn cycled the scene through 0/8/9/16/17/24/32/33/40/41
point lights, and three.js recompiled every visible lit material at each
count. That is why the first GPU prewarm (compileAsync under the portal-space
cover) compiled programs that were never used: it compiled the cover-time
count. Fix: `DatLightBudget` `fixedLightCount` pads with zero-intensity
fillers to ONE total (47 pool slots + 8 external headroom, external lights
counted every update), so the lit variant never changes. Then
`scene/RendererWarmup` (cover-time textures + compileAsync + 1×1 sweep; during
play, new subtrees get compileAsync + a 1×1 unlit geometry-upload draw) sticks.

| config | turning programs added | turning >50 / >100 ms | turning max |
|---|---|---|---|
| main (no warm, step padding), 2 runs | +156, +78 | 8/4, 5/0 | 208, 76 ms |
| warm only (the first PERF.4 patch), 2 runs | +71, +86 | 5/0, 5/0 | 84, 68 ms |
| fixed light count only | +10 | 0/0 | 27 ms |
| **warm + fixed count + play-time upload**, 3 runs | **0, 0, 0** | **0/0** | **18.5–18.7 ms** |

Run JSONs (10 s phases, `--program-keys`) were kept out of `verification/perf/` so they never become a ratchet baseline; they were exploratory A/B configs. Check a program-count jump with `--program-keys`. A key-field diff names the
parameter that is churning.

## Protocol

- `npx tsx tools/measure-perf.ts --ratchet` (idle/turning/running phases;
  JSON to verification/perf/ — commit the JSON). Renderer string recorded;
  NEVER compare frame times across renderers. Render metrics, `renderJs`
  and the census ARE comparable; `estimatedRealGpu` is the fps-flavoured
  number to quote.
- Any cycle touching renderer/world/streaming code runs it with `--ratchet`
  before close; exit code 2 (a >10% regression on any budget metric, or a
  `no-baseline` verdict at a new location) blocks the close until explained
  or fixed. Quote the `estimatedRealGpu` fps and the census deltas in the
  close note, not just draw calls.
- **Runs are only comparable at the same map location.** measure-perf samples
  wherever the persistent testacjs character is standing — a verification
  script that `@telepoi`s elsewhere and exits leaves the next run measuring a
  different scene (2026-08-29: a run at Eastham showed 39k draw calls vs the
  Holtburg baseline's ~15k — scene difference, not a regression). Since
  CORE.14.e measure-perf parks the character itself: `@telepoi holtburg` +
  `setPlayerYaw(0)` before every phase (skip with `--no-reset`, but such runs
  may not be ratchet-comparable). Treat any cross-location comparison as
  invalid.
- **Scene costs are phase MEANS, not end-of-phase point samples**
  (CORE.14.e). A single renderer.info read after a phase lands at an
  arbitrary camera heading — three same-code Holtburg runs on 2026-09-04
  point-sampled idle.drawCalls at 93 / 239 / 929 and turning.drawCalls at
  1046 → 228 → 1144, false-flagging the mechanical gate both directions.
  measure-perf now reads renderer.info ~once/second during each phase and
  records the mean (raw samples in the JSON under `renderSamples`; run
  marked `renderSampling: 'phase-mean-1s'`). The ratchet never compares a
  mean run against a legacy point-sample run — the first mean-mode run at a
  location starts a fresh baseline chain.
- Real-GPU runs: Jake's machine, visible tab (hidden tabs suspend rAF).
  Headed Playwright (`--headed`) hangs under the local harness (sandboxed
  launch) — it works only from a plain terminal. The harness-safe path is
  `--attach` (CORE.14.d): start Chrome yourself with
  `--remote-debugging-port=9222`, keep the game tab visible/frontmost, then
  `npx tsx tools/measure-perf.ts --attach --ratchet`. It reuses the open
  game tab (or opens one), measures, and disconnects leaving your browser
  up. On real-GPU runs the ratchet also compares measured per-phase avgFps
  (>10% drop = regression) — `isSoftwareRenderer` in perf-ratchet-lib
  decides which mode a run is in; SwiftShader runs stay scene-cost-only.
- measure-perf now warns (console + `warnings` in the JSON) when every frame
  of a phase dropped its physics substeps (`droppedFrames == frames`, dt >
  HugeQuantum): camera input applies inside the substep loop, so such a
  turning/running phase silently re-measured the idle scene — pre-CORE.14
  SwiftShader runs did exactly this (identical render info across phases was
  the tell). Treat a warned phase's numbers as untrustworthy.
- **CORE.18 (2026-09-26): the turning phase holds ArrowRight.** CORE.18 made
  the controls true-handed, so ArrowLeft now turns the other way through the
  world. ArrowRight sweeps the world-space arc (yaw increasing from 0) that
  ArrowLeft swept for every earlier baseline, so runs stay comparable. The
  CORE.18 same-server-state A/B (verification/perf/core18-ab/) found every
  metric within 4%. Server/streaming state alone moved the Holtburg census
  from 5,079 to 6,783 meshes between runs that day, so when a ratchet flags a
  change that crosses a server-state shift, confirm it with an A/B on the
  same state before filing.
- **CORE.18.a (2026-09-26): measure-perf settles facing yaw 0.** Login and
  @telepoi now turn the camera to the server heading (the saved one / the
  POI's), so the post-park scene settle ran facing that heading and uploaded
  a different geometry/texture set before idle's setYaw(0) (idle geometries
  1,760 vs 666 on the same state, draw calls/triangles identical). The run
  now calls setYaw(0) before the settle. Same-state A/B (pre-change renderer
  vs CORE.18.a, verification/perf/perf-2026-09-26T05-15-49-718Z.json vs
  …T05-22-46-173Z.json): idle 685/52,044/666 vs 685/52,044/668, running
  679/51,799 vs 677/51,776; turning draw calls 801 vs 906 sit inside the
  per-sample spread every run shows (467–1,244, PERF.6).

## Memory soak + CPU profile (2026-09-30)

- `npx tsx tools/perf-soak.ts --stops 8` (real GPU; on AC or above 20% battery: Chrome's Energy Saver caps fps at 30 only at 20% or lower by default, and the 2026-09-30 flat 30 fps was at 10% battery) runs before closing any task that touched renderer/world/streaming code, and as the PERF discovery lens. **Budget:** at the end of the route (after the forced GC), GPU textures and geometries must be within 25% of their start, and the process-tree RSS must not grow more than 1 GB. A metric that climbs at every stop and stays up is a leak: find its owner (docs/perf-pass-2026-09-30.md has the Texture.needsUpdate stack-hook recipe) and fix it the same cycle.
- `npx tsx tools/perf-profile.ts` gives the top main-thread self-time functions and the per-process RSS split (renderer / browser / GPU, and the ArrayBuffer backing store). Use it for any fps or hitch finding before changing code.
- Commit both JSONs under verification/perf/ with the cycle's evidence.

## Session soak, crash alarms and hitch budgets (2026-10-03)

**Why:** Jake's session went grey and every label went blank. The cause was
macOS IOSurface exhaustion: each GPU-backed 2D canvas holds one, and our text
canvases are many and recreated often. The teleport-only soak never exercised
UI, combat or chat, so nothing caught it.

**Fixes:**
- 2D canvases are CPU-backed by default (`ui/CanvasBacking.ts`).
- Tinted text draws from cached tinted glyph sheets (`ACFontRenderer`). That
  cut UI canvas churn by 46% with identical pixels.

**`tools/perf-soak.ts` is now a session soak.** At each stop it runs the route,
cycles every panel with the retail default keys, fights a spawned Drudge
Skulker in combat mode, and sends chat. `--minutes N` repeats the route for a
long run, and `--route-only` gives the old behaviour.

**Budgets** (`tools/perf-soak-lib.ts`), on top of the texture, geometry and RSS
ones above. Exit 2 on a breach:
- Zero graphics-context losses (WebGL or 2D) in the session.
- DOM nodes, event listeners and in-page canvases (outside the chat log, which
  its 100-line cap bounds) end within +25% (+20) of the first stop.
- **Hitches, real GPU only:** per phase (running, ui, combat, chat), worst-window
  p99 frame ≤ 50 ms and worst single frame ≤ 100 ms. Teleport arrival is
  exempt. These are about 2× the first run on the M3 Max
  (`soak-2026-10-03T15-14-39`):

  | phase | p99 | worst frame |
  |---|---|---|
  | running | 24.8 ms | 41.0 ms |
  | ui | 18.2 ms | 50.8 ms |
  | combat | 17.7 ms | 18.3 ms |
  | chat | 17.5 ms | 26.6 ms |
  | arrived | — | 250 ms |

**Crash alarms.** The page counts graphics-context losses into
`window.__acHealth` (`ui/ContextHealth.ts`). Portal space's deliberate
`forceContextLoss` is marked and excluded. `tools/lib/game-session.ts` records
page crashes. `shot()` and capture-ui-screens' captures refuse to capture after
a crash or context loss (`CrashSignal`), so a broken frame can't pass as
evidence. Live check: a forced `WEBGL_lose_context` was counted on
`#game-canvas` and the next shot was refused.

**Host contention.** The hitch budgets assume the Mac runs only the soak. The
soak samples what else is running at every stop: other Playwright browsers,
the retail client, and the 1-minute load average. It prints `host quiet: …`
or `HOST CONTENDED in n/m samples (…)`. A contended run's frame budgets are
not this build's alone, so re-run it before treating a breach as a
regression. The GPU worker holds perf and perf-soak jobs until the host is
quiet (docs/gpu-worker.md). Evidence (PERF.gpu-soak-hitch-ee124a12): five
2026-10-04 soaks from 20:40Z on broke the running p99 budget, the pre-range
commit 58f711db included, at 73–97 fps and main-thread busy 0.91–0.99. Every
earlier run that day held 115 fps at busy 0.78. Four of the five measured
another session's browser as their own RSS.

**Long run.** Once a day: `node tools/gpu-queue.mjs request --kind perf-soak
--task OPS.session-soak --minutes 60`. It runs on the Mac when the worker's
guards allow.

## Mid-play hitches: shader-program relinks (PERF.gpu-soak-frame-hitches-28a525da, 2026-10-04)

The 28a525da real-GPU session soak broke the hitch budget in every phase
(running p99 266.9 ms, worst frames 625 / 558 / 856 / 333 ms in running / ui /
combat / chat). `tools/hitch-probe.ts` attributes each Long Animation Frame
to the functions sampled inside it and logs every WebGLProgram three.js
creates or releases. On a two-town route (Arwic, Cragstone; SwiftShader) the
long frames during play were dominated by `WebGLProgram.getUniforms` →
`getProgramInfoLog` / `getShaderInfoLog`, the synchronous wait for a link.
14 of the 63 program keys were **relinked**: three.js destroys a program when
its last material is disposed (the resource sweep after a teleport, a
despawned monster, the paperdoll's copies), and the next material with the
same key compiles it again on its first draw.

**Fix (transparent):** `scene/ProgramRetention.ts` holds one extra reference
on every program the first time it appears (`SceneManager.render`), so none is
ever destroyed and `acquireProgram` finds it again by key. Probe, same route:
programs released 30 → 0, recompiled keys 14 → 0, link-stall time inside
long play-phase frames 5,351 → 945 ms. The program count now plateaus at the
session's distinct keys (64 here) instead of swinging 31–38; that is the
intended cache, not a leak.

What remains is first-use, not churn: the paperdoll's first render on the
first inventory open, and portal space's first draw. They are filed separately.

# Gelatin Game Engine — Water

Real-time ocean renderer for three.js (WebGL2), with a demo island scene.

```bash
npm install
npm run dev
```

Open the printed localhost URL. Orbit with the mouse. Pick shots from the `camera` dropdown (they also set the sun). The `benchmark (uncapped)` button renders 400 frames back-to-back to measure true throughput. It also runs once, 3 s after load.

## Performance

Measured with the in-page benchmark on an RTX 3060 (Chrome, ANGLE/D3D11), 4× MSAA, all features on. The pixel counts match each resolution; the aspect ratio was the browser window's.

| Pixels | ms / frame | fps (uncapped) |
|---|---|---|
| 977×846 | 1.2 | ~840 (CPU-bound) |
| 1080p-equivalent | 1.87 | ~535 |
| 1440p-equivalent | 2.70 | ~370 |
| 4K-equivalent | 3.35 | ~300 |

With floaters and underwater rendering, at 1954×1692 (3.3 MP, `devicePixelRatio` 2). Each number is the best of 5 × 200 frames:

| Shot | ms / frame | fps (uncapped) |
|---|---|---|
| Golden hour | 1.02 | ~980 |
| Flotsam (10 floating props) | 1.48 | ~675 |
| Breakers | 1.68 | ~595 |
| Underwater | 0.96 | ~1040 |

The underwater pass on its own measures 0.59 ms at that size with GPU timer queries. The reflection pass is skipped underwater.

The HUD's GPU timer-query numbers read high while vsync-capped, because the GPU downclocks when idle. Use the benchmark number.

## What's in it

**Waves** (`src/water/OceanSim.js`)
- Tessendorf FFT with 3 cascades of 600 / 85 / 12 m at 256². The ratio is non-integer, so tiling doesn't show.
- JONSWAP wind sea plus swell, with cos-2s directional spreading (Hasselmann spread power).
- The cascades are stacked in one 256×768 atlas, so each Stockham IFFT stage is one MRT draw: 16 in total.
- ω is quantised to a 300 s loop, so fp32 phase never drifts.
- Foam comes from the Jacobian, with dt-based recovery.
- Slopes are divided out at full resolution and stored as (sx, sz, sx², sz²). Their mips give the slope variance used for roughness (LEAN-style), which is what makes the far field and the glitter path correct instead of shimmering.

**Surface** (`src/water/OceanSurface.js`)
- A camera-centred polar grid (~190k verts) whose rings grow geometrically, scaled with camera height.
- Displacement is band-limited to the local vertex spacing with `textureLod`, so it doesn't swim and needs no clipmap snapping.
- Per-pixel shading:
  - Normals and variance roughness from 3 cascades.
  - Geometric specular AA.
  - Lagarde roughness-aware Fresnel.
  - GGX sun with the island's shadow.
  - Stochastic glitter on the bright sun path.
  - Half-res planar reflection of the island, falling back to the sky cube.
  - Depth-validated refraction.
  - Beer-Lambert absorption.
  - Atlas-style subsurface scatter on crests.
  - Foam that erodes as it ages.
  - Aerial perspective.
- Shoreline breakers come from a coast SDF baked at startup (`shoreMap.js`, exact EDT). Gerstner fronts travel up the distance gradient with these properties:
  - Green's-law shoaling.
  - A breaking limit.
  - Bigger sets on coasts facing the swell.
  - Whitewater whose foam texture rides along with the bore.
- FFT swell fades out in the shallows and the shore waves take over.

**Underwater** (`src/water/UnderwaterPass.js`, underside branch in `OceanSurface.js`)
- The water mesh is double-sided. Seen from below it shades Snell's window: the sky in the refracted direction, the sun lobe, and anything above the water from the frame, with total internal reflection outside the window.
- Folded crests flip triangles. Faces that can't face the camera's side are discarded.
- A fullscreen pass runs when the camera is within 1.2 m of the surface or below it:
  - Per-pixel waterline. The water pass tags what each pixel sees in alpha (top or underside), so the split follows the mesh. Where no water is visible, the near-plane point is tested against the exact surface (`waterAt`).
  - A meniscus line where the top meets the underside near the lens.
  - Beer-Lambert extinction over the camera-to-hit distance, towards an in-scatter colour that matches the underside, brighter looking up.
  - Sun shafts: 8 jittered steps of single scattering (Henyey-Greenstein) through the seabed caustic pattern, projected along the refracted sun. The caustic mip is chosen from how far each step moves through the pattern, so rays crossing it average to haze instead of banding.
- Underwater, exposure is boosted (`underwater exposure`) and the planar reflection is skipped. The camera is only kept out of the ground.

**Floating objects** (`src/water/WaterQuery.js`, `src/scene/floaters.js`, `src/scene/floaterMeshes.js`)
- Water heights come from the GPU. A 512×1 pass evaluates exactly the rendered surface (FFT cascades plus shore waves, with the choppy displacement inverted by fixed-point iteration). It is read back with `readRenderTargetPixelsAsync` (PBO + fence), so it never stalls. Results are 1–2 frames old, with at most 2 reads in flight.
- Slot 0 of each query is the camera, which drives the underwater test. The rest are each body's sample points.
- Rigid bodies (crate, barrel, buoy, boat):
  - Each body is split into cells. Each cell gets Archimedes buoyancy for its submerged fraction, plus drag against the local water velocity, applied at the cell. Heave, roll and pitch all come from that.
  - Water velocity is the change in queried displacement over time, clamped, because at steep fronts the fixed-point rate overstates particle speed.
  - 240 Hz substeps, box inertia, and a spring-and-friction contact with the island heightfield for beaching.
- The prop meshes are procedural, closed and vertex-coloured. They get the same underwater light absorption, caustics and fog patch as the terrain.

**Pipeline** (`src/main.js`)
1. Ingest the last water query, step the floaters, run the sim passes, submit the next query.
2. Planar reflection (half res, skipped underwater).
3. Opaque pass into a single 4× MSAA HDR target.
4. Water pass. three resolves colour and depth, then the resolved colour is restored into the MSAA buffer (three invalidates it), and the water is drawn depth-tested against the kept MSAA depth. This gives correct per-sample edges.
5. Underwater pass, when near or below the surface.
6. Dual-filter bloom with Karis average (`PostFX.js`), then AgX with a punchy look.

**Scene**
- Preetham sky with clouds, baked to a mipmapped 1024 HDR cube when the sun moves. It serves as the background, reflection, fog colour and IBL. The sun disc is analytic.
- Procedural island with biome shading, wet sand, sand ripples, sunlight absorbed through the water column, and min-blended procedural caustics.
- Instanced rocks.
- Shadow map that re-renders only when the sun moves.

Camera presets `Flotsam` and `Underwater` spawn a field of floating props. The `Floaters & underwater` folder has spawn, drop and clear buttons, plus drag, buoyancy, scattering, shaft and meniscus controls.

## Not in yet

- Wakes, splashes and object-to-water interaction. Floaters are moved by the water but don't disturb it.
- Floaters don't collide with each other and don't cast shadows, because the shadow map is static.
- Breakers are heightfield waves, so they never curl over.
- The surface mesh is a fan inside 1 m of the camera, so detail right at the lens is coarse when sitting on the waterline.

The design was argued out with a second agent before building. The main changes from the first plan were:
- A single-MSAA water pass instead of a manual depth compare.
- Planar reflection instead of SSR.
- Slope-moment roughness instead of a distance heuristic.
- Larger cascades.
- Shore waves.

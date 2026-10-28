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

**Pipeline** (`src/main.js`)
1. Sim passes.
2. Planar reflection (half res).
3. Opaque pass into a single 4× MSAA HDR target.
4. Water pass. three resolves colour and depth, then the resolved colour is restored into the MSAA buffer (three invalidates it), and the water is drawn depth-tested against the kept MSAA depth. This gives correct per-sample edges.
5. Dual-filter bloom with Karis average (`PostFX.js`), then AgX with a punchy look.

**Scene**
- Preetham sky with clouds, baked to a mipmapped 1024 HDR cube when the sun moves. It serves as the background, reflection, fog colour and IBL. The sun disc is analytic.
- Procedural island with biome shading, wet sand, sand ripples, sunlight absorbed through the water column, and min-blended procedural caustics.
- Instanced rocks.
- Shadow map that re-renders only when the sun moves.

## Not in v1

- Underwater rendering. The camera is clamped above the waves.
- Floating objects / buoyancy. This needs a CPU readback or a CPU copy of the displacement.
- Wakes and object interaction.
- Breakers are heightfield waves, so they never curl over.

The design was argued out with a second agent before building. The main changes from the first plan were:
- A single-MSAA water pass instead of a manual depth compare.
- Planar reflection instead of SSR.
- Slope-moment roughness instead of a distance heuristic.
- Larger cascades.
- Shore waves.

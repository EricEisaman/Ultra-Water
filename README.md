# Ultra Water

Real-time ocean renderer for three.js (WebGL2), with a demo island scene.

```bash
npm install
npm run dev
```

Open the printed localhost URL. Orbit with the mouse (or a finger: phones get their own profile, see [Phones and tablets](#phones-and-tablets)). Pick shots from the `camera` dropdown (they also set the sun). The performance panel (top left) shows the GPU, render size, fps, ms per frame and a 20 s graph. Its `Uncap FPS` button switches the loop off the display's refresh: frames then render back-to-back, with at most three in flight on the GPU, so the counter shows what the machine can do while the scene keeps running live. The screen still updates at its own rate. `Cap to display` switches back. `Run benchmark` (also `benchmark (uncapped)` in the settings) renders 300 frames back-to-back with the render loop paused and times them to GPU completion with a fence. The screen freezes for about a second while it runs, so it only runs when asked.

## Performance

Measured with the in-page benchmark on an RTX 3060 (Chrome, ANGLE/D3D11), 4× MSAA, all features on, at 1954×1692 (3.3 MP, the pixel count of 1440p; `devicePixelRatio` 2 on the browser window):

| Shot | ms / frame | fps (uncapped) |
|---|---|---|
| Open ocean | 3.30 | ~303 |
| Breakers | 4.17 | ~240 |
| Golden hour | 4.20 | ~238 |
| Lagoon | 4.48 | ~223 |
| Flotsam (10 floating props) | 4.62 | ~217 |
| Underwater | 4.71 | ~212 |
| Aerial | 4.80 | ~208 |

Per pass in Breakers: water 1.66 ms, opaque (island, rocks, props) 1.21, post 0.37, caustics 0.24, FFT sim ~0.45 (independent of resolution). Caustics cost more under a low sun (about 0.36 ms at 3.5° elevation), because the refracted rays fold more.

The crest-foam upgrade landed after this run. It adds three texture taps and some ALU per foam pixel only. It hasn't been re-measured cleanly yet, because another application was loading the GPU at the time.

Earlier versions of this README quoted numbers 2–4× lower. Those came from a benchmark that synced with `readPixels`/`finish`, which ANGLE doesn't wait on. The fence-based benchmark is the one to trust. The HUD's GPU timer-query numbers read high while vsync-capped, because the GPU downclocks between frames.

### Phones and tablets

The same build spots phones and tablets (a finger as the main pointer, `matchMedia('(pointer: coarse)')`) and starts them on a lighter profile. Desktop is unchanged. Add `?mobile` or `?desktop` to the URL to force either.

The mobile profile is resolution 0.6 (of the device pixel ratio, capped at 2), 2× MSAA, reflections at 0.35 scale and no bloom. On a phone the cost is mostly the number of render passes Chrome's GPU process has to translate, not pixels, so dropping bloom's 12 passes did more than lowering resolution. Auto resolution (`auto resolution` in the Quality folder) steps down by 0.05, to a floor of 0.5, when more than 4% of frames miss vsync over 2 s. It climbs back to 0.6 once frames are clean, and locks to a steady 30 fps if the floor still misses more than a quarter.

Measured on a OnePlus Nord 4 (Snapdragon 7+ Gen 3, Adreno 732, Chrome 156, which runs pages at 60 Hz on it), portrait, 424×782:

| Shot | live fps | missed frames | fps (uncapped) |
|---|---|---|---|
| Open ocean | 60 | 0% | 142 |
| Aerial | 60 | 0% | 118 |
| Underwater | 60 | 0% | 103 |
| Lagoon | 60 | 0% | 102 |
| Flotsam | 60 | 0% | 101 |
| Golden hour | 60 | 0% | 99 |
| Breakers | 60 | 0% | 95 |

With the desktop settings (708×1304, 4× MSAA, bloom) the same phone ran 41–50 fps live, missing up to a third of its frames, and 62 fps uncapped on average. Phone numbers move with temperature. These were taken warm (thermal status 1) while charging over USB.

## What's in it

**Waves** (`src/water/OceanSim.js`)
- Tessendorf FFT with 4 cascades of 600 / 85 / 12 / 2.1 m at 256², stacked in one 256×1024 atlas, so each Stockham IFFT stage is one MRT draw.
- The 2.1 m cascade is the capillary band. It uses capillary-gravity dispersion (ω² = gk + σk³/ρ), and only its slopes are used, not its displacement. The 12 m cascade hands its sub-35 cm band to it (`capillaryFade`, calibrated so the summed mean-square slope stays near Cox–Munk).
- JONSWAP wind sea plus swell, with cos-2s directional spreading.
- ω is quantised to a 300 s loop, so fp32 phase never drifts.
- Foam comes from the Jacobian, with dt-based recovery.
- Slopes are stored as (sx, sz, sx², sz²). Their mips give the slope variance used for roughness (LEAN-style). Each cascade's 1×1 mip is its mean-square slope, and the Cox–Munk remainder for the wind speed is added as unresolved roughness.

**Surface** (`src/water/OceanSurface.js`)
- A camera-centred polar grid (~190k verts) whose rings grow geometrically, scaled with camera height. Displacement is band-limited to the local vertex spacing with `textureLod`, so it doesn't swim.
- Per-pixel shading:
  - Normals and variance roughness from 4 cascades, geometric specular AA, Lagarde roughness-aware Fresnel.
  - GGX sun with the island's and the floaters' shadows.
  - Glints: the GGX lobe as a finite number of facets. Each pixel-sized cell draws a Poisson count of sun-mirroring facets, which crossfade between draws so they twinkle.
  - Half-res mipmapped planar reflection of the island over the sky cube, blurred by roughness.
  - Depth-validated refraction with a smooth fallback at object edges, Beer-Lambert absorption, Atlas-style subsurface scatter on crests, and aerial perspective.
- Shore breakers run on an eikonal travel-time field (`shoreMap.js`: fast sweeping from the coast with c = √(g·depth), then direction, front curvature and a ray-tube shoaling factor):
  - The phase is ω(τ + t), so fronts slow down, bunch up and refract around the bathymetry.
  - Green's law plus ray-tube shoaling, a breaking limit of 0.42 × depth, and bigger sets on coasts facing the swell.
  - Plunging lean near the break point, with translucent lips. The lean and both wave trains' Gerstner pinch share one budget, so the heightfield never folds over.
  - Peeling: each crest breaks early in some sections and late in others, with a new layout every wave.
  - Where fronts from two coast stretches meet (shocks), the waves fade out instead of folding into sheets.
- Foam:
  - The baked foam texture holds a lace pattern plus a "cauliflower" billow height and its gradient.
  - Crest whitewater is textured on the displaced surface with a world-space flow map that rides shoreward at the phase speed. Its two phases are crossfaded, which also makes it churn.
  - Coverage erodes with age, from solid whitewater to holes to lace. The billows bump the normal and shade their creases. Thin foam is tinted by the water under it and glows when backlit. Bubble tops get a little sheen.
  - Lace stays behind in the surf zone and drifts shoreward.
- Beach swash (shared GLSL with the terrain): each bore runs up the sand and drains back as a thin film with a foam edge, leaving a wet line that dries over a few seconds.
- Impact rings: a floater hitting the water starts Cauchy–Poisson ripple rings, plus a splash crown (`Spray.js`).
- FFT swell fades out in the shallows and the shore waves take over.

**Caustics** (`src/water/Caustics.js`)
- Area-ratio splatting (after Evan Wallace): a grid over the 12 m cascade is refracted through its slopes onto planes at 1.5, 4 and 10 m. Each landed triangle adds its area ratio, so the pattern has a mean of 1 and only redistributes the direct sun.
- The slopes are sampled with a cubic B-spline. With bilinear sampling every slope texel would land as its own bead along the caustic lines.
- Both splat targets are 4× MSAA, so fold slivers thinner than a texel add by coverage instead of breaking into dots. They are sized by the sun-disc blur at each depth: 512² (2.3 cm) for 1.5 m, 256² for 4 m and 10 m.
- Lookups go through the refracted entry point, so the seabed, the props and the underwater shafts all see the same pattern.

**Underwater** (`src/water/UnderwaterPass.js`, underside branch in `OceanSurface.js`)
- The water mesh is double-sided. Seen from below it shades Snell's window:
  - The sky in the refracted direction, the sun as a GGX transmission lobe, and anything above the water from the frame.
  - Outside the window, total internal reflection mirrors the deep-water colour.
  - The critical-angle edge is blurred by the roughness.
- A fullscreen pass runs when the camera is near or below the surface:
  - Waterline split per pixel. The water pass tags what each pixel sees in alpha; elsewhere a coarse 64×36 lens-depth target is used.
  - A meniscus line where the top meets the underside near the lens.
  - Beer-Lambert extinction towards an in-scatter colour that matches the underside.
  - Half-res sun shafts: 24 jittered steps of Henyey-Greenstein single scattering, lit through the wave caustics and the terrain and floater shadows at each sample's surface entry point, with a depth-aware 4-tap upsample.
- Marine snow (`MarineSnow.js`), exposure compensation under water (`underwater exposure`), and water droplets on the lens for a few seconds after surfacing.

**Floating objects** (`src/water/WaterQuery.js`, `src/scene/floaters.js`, `src/scene/floaterMeshes.js`, `src/scene/floaterShadow.js`)
- Water heights come from the GPU. A 512×1 pass evaluates exactly the rendered surface, and is read back asynchronously (PBO + fence), so it never stalls.
- Rigid bodies (crate, barrel, buoy, boat):
  - Buoyancy per cell, with drag against the local water velocity.
  - 240 Hz substeps.
  - Contact with the island heightfield for beaching.
- Floaters have their own sun shadow map: an ortho camera fitted to the bodies every frame, so the big static shadow map is never re-rendered. It is read by the water, the terrain (at the refracted entry point under water) and the shafts.

**Pipeline** (`src/main.js`)
1. Ingest the last water query, step the floaters, then:
   - render the floater shadow map;
   - update the impact rings;
   - run the FFT;
   - splat the caustics;
   - submit the next query.
2. Planar reflection (half res, skipped underwater).
3. Opaque pass into a single 4× MSAA HDR target.
4. Water pass, depth-tested against the kept MSAA depth for correct per-sample edges.
5. Underwater pass, when near or below the surface.
6. Post (`PostFX.js`):
   - GPU auto exposure, metered in log space and adapted over time; the GUI value is compensation.
   - Dual-filter bloom with Karis average.
   - AgX.
   - Lens droplets.
   - TPDF dither.

**Scene**
- Hillaire 2020 atmosphere (`atmosphere.js`): transmittance, multiple-scattering and sky-view LUTs with ozone. Clouds are on top. It is baked into a mipmapped 1024 HDR cube when the sun moves, and serves as the background, reflection, fog colour and IBL.
- Procedural island with:
  - Biome shading and wet sand.
  - Swash film and wet line.
  - Wave-formed sand ripples whose crests meander, fork and fade in patches.
  - Sunlight that arrives refracted under water, dimmed by Fresnel transmission and absorbed along its path. Both shadow maps are read at the surface entry point, so up-sun sand bars don't shadow the whole bed.
  - Wave caustics.
- Instanced rocks. The static shadow map re-renders only when the sun moves.

The `Water` folder has a `colour preset` dropdown (clear, tropical, toxic green, purple, rust orange, murky brown). Each sets the absorption, in-scatter colour, thin-foam tint and underwater scattering together; `clarity` and `scatter` still adjust on top.

Camera presets `Flotsam` and `Underwater` spawn a field of floating props. The `Floaters & underwater` folder has spawn, drop and clear buttons, plus drag, buoyancy, scattering, shaft and meniscus controls.

## Not in yet

- Wakes behind moving objects. Floaters only disturb the water when they drop in (rings and splash).
- Floaters don't collide with each other.
- Breakers are heightfield waves, so they lean but never curl over into a tube.
- The surface mesh is a fan inside 1 m of the camera, so detail right at the lens is coarse when sitting on the waterline.

The design was argued out with a second agent before building, and again for each round of upgrades.

## License

MIT, see [LICENSE](LICENSE). Code adapted from other projects is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

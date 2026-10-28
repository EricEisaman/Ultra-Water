import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { OceanSim, defaultOceanParams } from './water/OceanSim.js';
import { OceanSurface } from './water/OceanSurface.js';
import { bakeShoreMap } from './water/shoreMap.js';
import { bakeWaterTextures } from './water/bakeTextures.js';
import { SkySystem } from './scene/sky.js';
import { createTerrain } from './scene/terrain.js';
import { islandHeight } from './scene/islandHeight.js';
import { PlanarReflection } from './engine/PlanarReflection.js';
import { PostFX } from './engine/PostFX.js';
import { GpuTimer } from './engine/gpuTimer.js';
import { FullscreenQuad, rawPass } from './engine/fullscreen.js';

const REFLECT_LAYER = 1;

const renderer = new THREE.WebGLRenderer({
  antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance',
});
renderer.autoClear = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
document.body.appendChild(renderer.domElement);

const quality = { resolution: 1, msaa: 4, reflections: true, reflectionScale: 0.5 };
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 80000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxDistance = 6000;

// --- world ------------------------------------------------------------------------
const sky = new SkySystem(renderer);
const shore = bakeShoreMap(islandHeight, 1800, 512);
const tex = bakeWaterTextures(renderer);
const ocean = new OceanSim(renderer, defaultOceanParams());
const surface = new OceanSurface(ocean, shore, sky);
surface.uniforms.uFoamTex.value = tex.foam;

const scene = new THREE.Scene();
scene.environment = sky.cube;
scene.add(sky.background);
const terrain = createTerrain({
  sky, caustics: tex.caustics, absorption: surface.uniforms.uAbsorption.value, reflectionLayer: REFLECT_LAYER,
});
scene.add(terrain.group);

const sunLight = new THREE.DirectionalLight(0xffffff, Math.PI);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(4096, 4096);
Object.assign(sunLight.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 10, far: 5000 });
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.6;
scene.add(sunLight, sunLight.target);
surface.uniforms.uShadowMatrix.value = sunLight.shadow.matrix;
surface.uniforms.uShadowTexel.value.set(1 / 4096, 1 / 4096);

const reflection = new PlanarReflection(REFLECT_LAYER);
surface.uniforms.uReflMatrix.value = reflection.textureMatrix;
const emptyReflection = new THREE.DataTexture(new Uint8Array(4), 1, 1);
emptyReflection.needsUpdate = true;

// water pass: restore the resolved opaque colour into the MSAA buffer (three
// invalidates it after resolve; depth survives), then draw water depth-tested.
const restore = new FullscreenQuad(rawPass(/* glsl */`
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`, { uTex: { value: null } }));
restore.mesh.renderOrder = -1;
const waterScene = new THREE.Scene();
waterScene.add(restore.mesh, surface.mesh);

const post = new PostFX(renderer);
post.params.bloomStrength = 0.05;
post.params.bloomThreshold = 1.5;
const look = { exposure: 0.55 };

let hdrRT = null;
function makeTargets() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  hdrRT?.dispose();
  hdrRT = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType, samples: quality.msaa, generateMipmaps: false,
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
  });
  restore.material.uniforms.uTex.value = hdrRT.texture;
  surface.uniforms.uSceneColor.value = hdrRT.texture;
  surface.uniforms.uSceneDepth.value = hdrRT.depthTexture;
  surface.uniforms.uResolution.value.copy(size);
  reflection.scale = quality.reflectionScale;
  reflection.setSize(size.x, size.y);
  post.setSize(size.x, size.y);
}

function resize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * quality.resolution);
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  makeTargets();
}
window.addEventListener('resize', resize);

let sunDirty = true;
function applySun() {
  sky.update();
  sunLight.position.copy(sky.sunDir).multiplyScalar(2000);
  sunLight.color.setRGB(sky.sunColor.x, sky.sunColor.y, sky.sunColor.z).multiplyScalar(1 / Math.max(sky.sunColor.x, 1e-4));
  sunLight.intensity = Math.PI * Math.max(sky.sunColor.x, 1e-4);
  renderer.shadowMap.needsUpdate = true;
  updateExposure();
  sunDirty = false;
}

// crude auto-exposure from horizontal sun + sky irradiance, so noon isn't blown out
function updateExposure() {
  const c = sky.sunColor, lum = 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
  const E = Math.PI * Math.max(lum, 0.05) * (Math.max(sky.sunDir.y, 0) + 0.25);
  post.params.exposure = look.exposure * 2.2 / Math.pow(E, 0.85);
}

// --- camera presets -----------------------------------------------------------------
function coast(bearingDeg) {
  const a = THREE.MathUtils.degToRad(bearingDeg);
  let r = 100;
  while (r < 800 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > 0) r += 2;
  return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
}
function sunBearing() { return Math.atan2(sky.sunDir.z, sky.sunDir.x); }
function setSun(elevation, azimuth) {
  Object.assign(sky.params, { elevation, azimuth });
  fSun?.controllers.forEach((c) => c.updateDisplay());
  applySun();
}
const views = {
  'Golden hour': () => {
    setSun(6, 205);
    const b = sunBearing(), c = coast(THREE.MathUtils.radToDeg(b) + 18);
    camera.position.set(c.x + Math.cos(b) * 120, 5, c.y + Math.sin(b) * 120);
    controls.target.set(c.x + Math.cos(b) * 400, 0, c.y + Math.sin(b) * 400);
  },
  'Breakers': () => {
    setSun(22, 205);
    const b = sunBearing() + 1.9, c = coast(THREE.MathUtils.radToDeg(b));
    camera.position.set(c.x + Math.cos(b) * 35 + Math.sin(b) * 40, 3.2, c.y + Math.sin(b) * 35 - Math.cos(b) * 40);
    controls.target.set(c.x - Math.sin(b) * 30, 0, c.y + Math.cos(b) * 30);
  },
  'Lagoon': () => {
    setSun(52, 205);
    const b = sunBearing() + Math.PI, c = coast(THREE.MathUtils.radToDeg(b));
    camera.position.set(c.x * 0.86, 28, c.y * 0.86);
    controls.target.set(c.x * 1.25, 0, c.y * 1.25);
  },
  'Open ocean': () => {
    setSun(14, 205);
    const b = sunBearing() + 0.5;
    camera.position.set(Math.cos(b) * 1500, 9, Math.sin(b) * 1500);
    controls.target.set(Math.cos(b) * 2400, 0, Math.sin(b) * 2400 + 600);
  },
  'Aerial': () => {
    setSun(30, 205);
    camera.position.set(900, 420, 900);
    controls.target.set(0, 0, 0);
  },
};

let fSun = null;
// --- GUI -----------------------------------------------------------------------
const gui = new GUI({ title: 'Gelatin Water' });
const ui = { view: 'Golden hour', benchmark: () => runBenchmark() };
gui.add(ui, 'view', Object.keys(views)).name('camera').onChange((v) => views[v]());
gui.add(ui, 'benchmark').name('benchmark (uncapped)');

fSun = gui.addFolder('Sun & sky');
fSun.add(sky.params, 'elevation', -2, 70, 0.1).onChange(() => (sunDirty = true));
fSun.add(sky.params, 'azimuth', 0, 360, 0.5).onChange(() => (sunDirty = true));
fSun.add(sky.params, 'sunIntensity', 0, 20, 0.1).onChange(() => (sunDirty = true));
fSun.add(sky.params, 'cloudCoverage', 0, 1, 0.01).onChange(() => (sunDirty = true));
fSun.add(sky.params, 'turbidity', 1, 10, 0.1).onChange(() => (sunDirty = true));

const op = ocean.params, dirty = () => (ocean.dirty = true);
const fWave = gui.addFolder('Waves');
fWave.add(op, 'windSpeed', 1, 25, 0.1).onChange(dirty);
fWave.add(op, 'windDirection', -180, 180, 1).onChange(dirty);
fWave.add(op, 'fetchKm', 5, 1000, 1).onChange(dirty);
fWave.add(op, 'waveScale', 0, 3, 0.01).onChange(dirty);
fWave.add(op, 'spreadBlend', 0, 1, 0.01).onChange(dirty);
fWave.add(op, 'swellScale', 0, 3, 0.01).onChange(dirty);
fWave.add(op, 'swellDirection', -180, 180, 1).onChange(dirty);
fWave.add(op, 'choppiness', 0, 2, 0.01);
fWave.add(op, 'timeScale', 0, 3, 0.01);

const su = surface.uniforms;
const shoreUi = { amplitude: su.uShoreWave.value.x, wavelength: su.uShoreWave.value.y, speed: su.uShoreWave.value.z, steepness: su.uShoreWave.value.w };
const setShore = () => su.uShoreWave.value.set(shoreUi.amplitude, shoreUi.wavelength, shoreUi.speed, shoreUi.steepness);
const fShore = gui.addFolder('Shore waves');
fShore.add(shoreUi, 'amplitude', 0, 1.5, 0.01).onChange(setShore);
fShore.add(shoreUi, 'wavelength', 8, 60, 0.5).onChange(setShore);
fShore.add(shoreUi, 'speed', 0.3, 2, 0.01).onChange(setShore);
fShore.add(shoreUi, 'steepness', 0, 1.5, 0.01).onChange(setShore);

const fWater = gui.addFolder('Water');
const w = {
  roughness: su.uOptics.value.x, refraction: su.uOptics.value.y, reflectionDistort: su.uOptics.value.z,
  sssPeak: su.uSSS.value.x, sssView: su.uSSS.value.y,
  foamBias: su.uFoam.value.x, foamScale: su.uFoam.value.y, shoreFoamBand: su.uFoam.value.z,
  foamRecovery: op.foamRecovery, caustics: terrain.uniforms.uCausticStrength.value,
  scatter: '#' + su.uScatterColor.value.getHexString(),
  clarity: 1,
};
const absorptionBase = su.uAbsorption.value.clone();
const setWater = () => {
  su.uOptics.value.x = w.roughness; su.uOptics.value.y = w.refraction; su.uOptics.value.z = w.reflectionDistort;
  su.uSSS.value.x = w.sssPeak; su.uSSS.value.y = w.sssView;
  su.uFoam.value.x = w.foamBias; su.uFoam.value.y = w.foamScale; su.uFoam.value.z = w.shoreFoamBand;
  op.foamRecovery = w.foamRecovery;
  terrain.uniforms.uCausticStrength.value = w.caustics;
  su.uScatterColor.value.set(w.scatter);
  su.uAbsorption.value.copy(absorptionBase).multiplyScalar(1 / w.clarity);
};
fWater.add(w, 'clarity', 0.2, 4, 0.01).onChange(setWater);
fWater.addColor(w, 'scatter').onChange(setWater);
fWater.add(w, 'roughness', 0.005, 0.2, 0.001).onChange(setWater);
fWater.add(w, 'refraction', 0, 0.2, 0.001).onChange(setWater);
fWater.add(w, 'reflectionDistort', 0, 0.2, 0.001).onChange(setWater);
fWater.add(w, 'sssPeak', 0, 6, 0.01).onChange(setWater);
fWater.add(w, 'sssView', 0, 0.5, 0.001).onChange(setWater);
fWater.add(w, 'foamBias', -0.5, 1.5, 0.01).onChange(setWater);
fWater.add(w, 'foamScale', 0, 6, 0.01).onChange(setWater);
fWater.add(w, 'foamRecovery', 0.05, 3, 0.01).onChange(setWater);
fWater.add(w, 'shoreFoamBand', 0, 2, 0.01).onChange(setWater);
fWater.add(w, 'caustics', 0, 8, 0.01).onChange(setWater);

const fPost = gui.addFolder('Post');
fPost.add(look, 'exposure', 0.1, 4, 0.01).name('exposure comp').onChange(updateExposure);
fPost.add(post.params, 'bloomStrength', 0, 0.5, 0.001);
fPost.add(post.params, 'bloomThreshold', 0, 10, 0.01);

const fQ = gui.addFolder('Quality');
fQ.add(quality, 'resolution', 0.25, 1, 0.05).onFinishChange(resize);
fQ.add(quality, 'msaa', [0, 2, 4, 8]).onChange(makeTargets);
fQ.add(quality, 'reflections');
fQ.add(quality, 'reflectionScale', 0.25, 1, 0.05).onFinishChange(makeTargets);
[fWave, fShore, fWater, fPost].forEach((f) => f.close());

// --- frame ---------------------------------------------------------------------
const gl = renderer.getContext();
const timer = new GpuTimer(gl);
let elapsed = 0, timing = true;

function renderFrame(dt) {
  elapsed += dt;
  if (sunDirty) applySun();
  if (timing) timer.beginFrame();

  ocean.update(dt, timer);
  surface.update(camera, elapsed % 3600);
  terrain.uniforms.uTimeT.value = elapsed % 3600;

  timer.begin('reflection');
  if (quality.reflections) {
    reflection.render(renderer, scene, camera);
    su.uReflection.value = reflection.target.texture;
  } else su.uReflection.value = emptyReflection;

  timer.begin('opaque');
  renderer.setRenderTarget(hdrRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);

  timer.begin('water');
  su.uShadowMap.value = sunLight.shadow.map.depthTexture;
  renderer.render(waterScene, camera);

  timer.begin('post');
  post.render(hdrRT.texture);
  if (timing) timer.endFrame();
}

function clampCamera() {
  // stay above the tallest waves; no underwater rendering in v1
  const minY = 1.2 + 0.03 * op.windSpeed * op.windSpeed * op.waveScale;
  const ground = islandHeight(camera.position.x, camera.position.z) + 1.5;
  const floor = Math.max(minY, ground);
  if (camera.position.y < floor) camera.position.y = floor;
}

function runBenchmark(frames = 400) {
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  timing = false;
  for (let i = 0; i < 20; i++) renderFrame(1 / 200);
  sync();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) renderFrame(1 / 200);
  sync();
  const ms = (performance.now() - t0) / frames;
  timing = true;
  bench = `benchmark: ${ms.toFixed(2)} ms/frame = ${(1000 / ms).toFixed(0)} fps uncapped (${frames} frames)`;
  console.log(bench);
  return ms;
}
window.runBenchmark = runBenchmark;
window.app = { camera, controls, sky, post, surface, ocean, terrain, timer, views, quality, renderer, markSun: () => (sunDirty = true) };

// --- HUD + loop ------------------------------------------------------------------
const hud = document.getElementById('hud');
let bench = '', frames = 0, lastHud = performance.now(), last = performance.now();
const gpuInfo = (() => {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).replace(/ANGLE \(|\)$/g, '') : 'unknown GPU';
})();

function updateHud(now) {
  const fps = (frames * 1000) / (now - lastHud);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  let text = `${gpuInfo}\n${size.x}×${size.y}  MSAA ${quality.msaa}x  display fps ${fps.toFixed(0)}`;
  if (timer.available && timer.total > 0) {
    text += `\nGPU ${timer.total.toFixed(2)} ms -> ${(1000 / timer.total).toFixed(0)} fps GPU-bound`;
    for (const [k, v] of Object.entries(timer.ms)) text += `\n  ${k.padEnd(10)} ${v.toFixed(3)} ms`;
  } else text += '\n(GPU timer queries unavailable; use benchmark)';
  if (bench) text += `\n${bench}`;
  hud.textContent = text;
  frames = 0;
  lastHud = now;
}

function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  controls.update();
  clampCamera();
  renderFrame(dt);
  frames++;
  if (now - lastHud > 500) updateHud(now);
  requestAnimationFrame(loop);
}

resize();
applySun();
views[ui.view]();
controls.update();
requestAnimationFrame(loop);

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// Preetham sky + clouds baked into a mipmapped HDR cube whenever the sun moves.
// The cube is the background, the water's reflection/fog source and the terrain IBL;
// no fbm runs per pixel at frame time. The sun disc is analytic (background shader +
// water specular), so it's left out of the cube.
const CUBE_SIZE = 1024;

const BG_VERT = /* glsl */`
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = p.xyww; // far plane
}`;

const BG_FRAG = /* glsl */`
uniform samplerCube uCube;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
in vec3 vDir;
out vec4 fragColor;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = textureLod(uCube, vec3(d.x, max(d.y, 0.0), d.z), 0.0).rgb;
  float c = dot(d, uSunDir);
  // 0.27 deg disc with limb darkening, plus a tight glow
  float disc = smoothstep(0.999985, 0.999992, c) * (0.6 + 0.4 * smoothstep(0.999985, 1.0, c));
  col += uSunColor * (disc * 900.0 + pow(max(c, 0.0), 2200.0) * 1.5) * step(0.0, d.y);
  fragColor = vec4(col, 1.0);
}`;

export class SkySystem {
  constructor(renderer) {
    this.renderer = renderer;
    this.cubeSize = CUBE_SIZE;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunColor = new THREE.Vector3(1, 1, 1);
    this.params = { elevation: 6, azimuth: 205, turbidity: 2, rayleigh: 1, cloudCoverage: 0.38, sunIntensity: 7 };

    this.sky = new Sky();
    this.sky.scale.setScalar(100);
    const u = this.sky.material.uniforms;
    u.mieCoefficient.value = 0.0025;
    u.mieDirectionalG.value = 0.88;
    u.cloudDensity.value = 0.55;
    u.cloudElevation.value = 0.55;
    u.showSunDisc.value = 0;
    this.skyScene = new THREE.Scene();
    this.skyScene.add(this.sky);

    this.cubeRT = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, {
      type: THREE.HalfFloatType, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    this.cubeCamera = new THREE.CubeCamera(1, 1000, this.cubeRT);
    this.cube = this.cubeRT.texture;

    this.background = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: BG_VERT, fragmentShader: BG_FRAG,
        uniforms: { uCube: { value: this.cube }, uSunDir: { value: this.sunDir }, uSunColor: { value: this.sunColor } },
        side: THREE.BackSide, depthWrite: false,
      }),
    );
    this.background.frustumCulled = false;
    this.background.renderOrder = -1000;
  }

  update() {
    const p = this.params, u = this.sky.material.uniforms;
    const phi = THREE.MathUtils.degToRad(90 - p.elevation);
    const theta = THREE.MathUtils.degToRad(p.azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.cloudCoverage.value = p.cloudCoverage;

    // sun irradiance through the atmosphere: Kasten-Young air mass, per-channel extinction
    const e = Math.max(p.elevation, 0);
    const airmass = 1 / (Math.sin(THREE.MathUtils.degToRad(e)) + 0.50572 * Math.pow(e + 6.07995, -1.6364));
    const tau = [0.032, 0.075, 0.19].map((t) => t * (0.6 + 0.12 * p.turbidity));
    const fade = THREE.MathUtils.smoothstep(p.elevation, -2, 2);
    this.sunColor.set(...tau.map((t) => Math.exp(-t * airmass) * p.sunIntensity * fade));

    this.cubeCamera.update(this.renderer, this.skyScene);
    this.cube.needsPMREMUpdate = true;
  }
}

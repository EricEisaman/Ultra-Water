import * as THREE from 'three';

// Bakes (height, signed coast distance, ∇sdf.x, ∇sdf.z) into one float texture.
// sdf > 0 offshore, < 0 on land, in metres. Exact EDT (Felzenszwalb) then a light
// blur so the gradient doesn't flip hard along medial axes in bays.

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// squared distance (texels) from every texel to the nearest texel where mask is true
function edt2d(mask, size) {
  const out = new Float64Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0 : INF;
  const f = new Float64Array(size), d = new Float64Array(size), v = new Int32Array(size), z = new Float64Array(size + 1);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) f[y] = out[y * size + x];
    edt1d(f, size, d, v, z);
    for (let y = 0; y < size; y++) out[y * size + x] = d[y];
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) f[x] = out[y * size + x];
    edt1d(f, size, d, v, z);
    for (let x = 0; x < size; x++) out[y * size + x] = d[x];
  }
  return out;
}

function boxBlur(src, size, r) {
  const tmp = new Float32Array(src.length), dst = new Float32Array(src.length);
  const at = (a, x, y) => a[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += at(src, x + i, y);
    tmp[y * size + x] = s / (2 * r + 1);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let s = 0; for (let i = -r; i <= r; i++) s += at(tmp, x, y + i);
    dst[y * size + x] = s / (2 * r + 1);
  }
  return dst;
}

export function bakeShoreMap(heightFn, extent, size = 512) {
  const texel = extent / size;
  const height = new Float32Array(size * size);
  const land = new Uint8Array(size * size), sea = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const h = heightFn(((i + 0.5) / size - 0.5) * extent, ((j + 0.5) / size - 0.5) * extent);
    const k = j * size + i;
    height[k] = h; land[k] = h > 0; sea[k] = h <= 0;
  }
  const toLand = edt2d(land, size), toSea = edt2d(sea, size);
  let sdf = new Float32Array(size * size);
  for (let k = 0; k < sdf.length; k++) {
    // half-texel offset puts the zero crossing between land and sea texels
    sdf[k] = sea[k] ? (Math.sqrt(toLand[k]) - 0.5) * texel : -(Math.sqrt(toSea[k]) - 0.5) * texel;
  }
  sdf = boxBlur(boxBlur(sdf, size, 2), size, 2);

  const data = new Float32Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i;
    const s = (x, y) => sdf[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
    data[k * 4] = height[k];
    data[k * 4 + 1] = sdf[k];
    data[k * 4 + 2] = (s(i + 1, j) - s(i - 1, j)) / (2 * texel);
    data[k * 4 + 3] = (s(i, j + 1) - s(i, j - 1)) / (2 * texel);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { texture: tex, extent, data, size };
}

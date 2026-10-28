import * as THREE from 'three';
import { islandHeight, ISLAND_SIZE } from './islandHeight.js';

// Grid mesh of the island plus a float heightmap of the same footprint,
// which the water uses for shore depth (wave damping, shallow colour, foam).
export function buildTerrain(segments = 384, mapSize = 256) {
  const geo = new THREE.PlaneGeometry(ISLAND_SIZE, ISLAND_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, islandHeight(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const data = new Float32Array(mapSize * mapSize);
  for (let j = 0; j < mapSize; j++) {
    for (let i = 0; i < mapSize; i++) {
      const x = ((i + 0.5) / mapSize - 0.5) * ISLAND_SIZE;
      const z = ((j + 0.5) / mapSize - 0.5) * ISLAND_SIZE;
      data[j * mapSize + i] = islandHeight(x, z);
    }
  }
  const heightMap = new THREE.DataTexture(data, mapSize, mapSize, THREE.RedFormat, THREE.FloatType);
  heightMap.minFilter = heightMap.magFilter = THREE.LinearFilter;
  heightMap.wrapS = heightMap.wrapT = THREE.ClampToEdgeWrapping;
  heightMap.needsUpdate = true;

  return { geometry: geo, heightMap };
}

// Beacons (the main loop), the lighthouse finale ring, and glimmers (optional).
import * as THREE from 'three';
import { Builder, M, MAT, box, cyl, lathe, uniforms } from '../world/assets';
import { BEACONS, FINALE, GLIMMERS, type BeaconDef } from '../world/layout';
import { groundHeight } from '../world/terrain';
import { makeLightPool } from '../world/structures';
import type { Physics } from '../core/physics';

const flameMat = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uTime: uniforms.uTime, uI: { value: 0 }, uSeed: { value: Math.random() * 10 } },
  vertexShader: /* glsl */`
    uniform float uTime, uSeed, uI; varying float vY; varying vec3 vN;
    void main(){
      vec3 p = position;
      float y = clamp(p.y / 1.6, 0.0, 1.0);
      p.x += sin(uTime * 9.0 + p.y * 4.0 + uSeed) * 0.12 * y;
      p.z += cos(uTime * 7.0 + p.y * 3.0 + uSeed) * 0.12 * y;
      p.y *= 0.85 + 0.25 * sin(uTime * 13.0 + uSeed) * 0.5 + 0.15 * uI;
      vY = y; vN = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform float uI; varying float vY; varying vec3 vN;
    void main(){
      vec3 hot = vec3(1.0, 0.95, 0.7), mid = vec3(1.0, 0.55, 0.15), tip = vec3(0.95, 0.22, 0.3);
      vec3 c = mix(hot, mid, smoothstep(0.0, 0.45, vY));
      c = mix(c, tip, smoothstep(0.45, 1.0, vY));
      float rim = pow(abs(vN.z), 1.5);
      float a = (1.0 - smoothstep(0.55, 1.0, vY)) * (0.35 + rim * 0.65);
      gl_FragColor = vec4(c * a * uI * 2.2, 1.0);
    }`,
});

const ringMat = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uTime: uniforms.uTime, uProgress: { value: 0 }, uActive: { value: 1 }, uColor: { value: new THREE.Color(0xffc56b) } },
  polygonOffset: true, polygonOffsetFactor: -4,
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uProgress, uActive; uniform vec3 uColor; varying vec2 vUv;
    void main(){
      vec2 p = vUv - 0.5;
      float r = length(p) * 2.0;
      float ang = atan(p.y, p.x) / 6.28318 + 0.5;
      float ring = smoothstep(0.86, 0.9, r) * smoothstep(1.0, 0.95, r);
      float dashes = step(0.5, fract(ang * 24.0 - uTime * 0.25));
      float fill = step(ang, uProgress) * smoothstep(0.7, 0.74, r) * smoothstep(0.86, 0.82, r);
      float pulse = 0.55 + 0.45 * sin(uTime * 3.0);
      float inner = smoothstep(0.9, 0.0, r) * 0.12 * pulse;
      float a = (ring * mix(0.5, 1.0, dashes) * pulse + fill * 1.6 + inner) * uActive;
      gl_FragColor = vec4(uColor * a, 1.0);
    }`,
});

export interface Beacon {
  def: BeaconDef;
  pos: THREE.Vector3;
  lit: boolean;
  progress: number;
  flame: THREE.Group;
  flameMats: THREE.ShaderMaterial[];
  ring: THREE.Mesh;
  pool: THREE.Mesh;
  bowl: THREE.Mesh;
  litAt: number;
  marker: THREE.Object3D;
}

export class Objectives {
  group = new THREE.Group();
  beacons: Beacon[] = [];
  finale!: Beacon;
  glimmers: { pos: THREE.Vector3; taken: boolean; t: number }[] = [];
  glimmerMesh!: THREE.InstancedMesh;
  glimmerHalo!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();

  constructor(private physics: Physics) {}

  build() {
    const base = new Builder()
      .add(cyl(1.7, 1.95, 0.45, 8), 0x948aa5, M(0, 0.15, 0), { jitter: 0.04, vary: 0.1 })
      .add(cyl(1.2, 1.45, 0.4, 8), 0xc2b5bd, M(0, 0.55, 0), { jitter: 0.03, vary: 0.08 })
      .add(cyl(0.38, 0.55, 1.1, 8), 0xc2b5bd, M(0, 1.3, 0), { jitter: 0.03 })
      .add(box(1.6, 0.12, 0.12), 0x3a3346, M(0, 1.55, 0, 0, 0.4, 0))
      .add(box(0.12, 0.12, 1.6), 0x3a3346, M(0, 1.55, 0, 0, 0.4, 0))
      .build();
    const bowlGeo = new Builder()
      .add(lathe([[0.15, 0], [0.75, 0.25], [1.0, 0.55], [0.92, 0.6], [0.7, 0.35], [0.1, 0.12]], 10), 0x3a3346, M(), { vary: 0.05 })
      .build();
    const make = (def: BeaconDef, isFinale = false): Beacon => {
      const y = groundHeight(def.x, def.z);
      const pos = new THREE.Vector3(def.x, y, def.z);
      if (!isFinale) {
        const b = new THREE.Mesh(base, MAT.std);
        b.position.copy(pos);
        b.scale.setScalar(1.35);
        b.castShadow = true; b.receiveShadow = true;
        this.group.add(b);
        this.physics.cylFixed(def.x, y + 1.2, def.z, 1.3, 1.2, 'beacon');
      }
      const bowl = new THREE.Mesh(bowlGeo, MAT.metal);
      bowl.position.set(def.x, y + 2.5, def.z);
      bowl.scale.setScalar(1.35);
      if (!isFinale) this.group.add(bowl);
      const flame = new THREE.Group();
      const flameMats: THREE.ShaderMaterial[] = [];
      for (let i = 0; i < 3; i++) {
        const m = flameMat();
        flameMats.push(m);
        const geo = new THREE.ConeGeometry(0.55 - i * 0.14, 1.6 - i * 0.3, 10, 6, true);
        geo.translate(0, (1.6 - i * 0.3) / 2, 0);
        const f = new THREE.Mesh(geo, m);
        f.rotation.y = i * 1.3;
        f.position.set((i - 1) * 0.12, 0, (i % 2) * 0.1);
        flame.add(f);
      }
      flame.position.set(def.x, y + 3.0, def.z);
      flame.visible = false;
      if (!isFinale) this.group.add(flame);
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 7.6), ringMat());
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(def.x, y + 0.12, def.z);
      ring.renderOrder = 5;
      this.group.add(ring);
      const pool = makeLightPool(def.x, def.z, 16, 0xff9a40);
      this.group.add(pool);
      // tall soft marker visible from afar
      const marker = new THREE.Mesh(
        new THREE.CylinderGeometry(0.25, 0.25, 60, 8, 1, true),
        new THREE.ShaderMaterial({
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
          uniforms: { uTime: uniforms.uTime, uA: { value: 1 } },
          vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
          fragmentShader: `uniform float uTime, uA; varying vec2 vUv;
            void main(){ float a = (1.0 - vUv.y) * (1.0 - vUv.y) * 0.25 * (0.7 + 0.3 * sin(uTime * 2.0)); gl_FragColor = vec4(vec3(1.0, 0.75, 0.4) * a * uA, 1.0); }`,
        }),
      );
      marker.position.set(def.x, y + 30, def.z);
      this.group.add(marker);
      return { def, pos, lit: false, progress: 0, flame, flameMats, ring, pool, bowl, litAt: -1, marker };
    };
    for (const d of BEACONS) this.beacons.push(make(d));
    this.finale = make({ id: 5, name: 'The Lighthouse', x: FINALE.x, z: FINALE.z, hint: 'at the top of the hill' }, true);
    this.finale.ring.visible = false;
    this.finale.marker.visible = false;
    (this.finale.ring.material as THREE.ShaderMaterial).uniforms.uColor.value.setHex(0xfff0b0);

    // glimmers
    const star = new THREE.OctahedronGeometry(0.28, 0);
    star.scale(1, 1.5, 1);
    const sm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd36b).multiplyScalar(2.2) });
    this.glimmerMesh = new THREE.InstancedMesh(star, sm, GLIMMERS.length);
    const halo = new THREE.PlaneGeometry(1.4, 1.4);
    const hm = new THREE.MeshBasicMaterial({ map: (makeLightPool(0, 0, 1).material as THREE.MeshBasicMaterial).map, color: 0xffc860, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    this.glimmerHalo = new THREE.InstancedMesh(halo, hm, GLIMMERS.length);
    for (const [x, z, h] of GLIMMERS) {
      const g = groundHeight(x, z);
      this.glimmers.push({ pos: new THREE.Vector3(x, Math.max(g, 0.15) + h, z), taken: false, t: 0 });
    }
    this.glimmerMesh.frustumCulled = false;
    this.glimmerHalo.frustumCulled = false;
    this.group.add(this.glimmerMesh, this.glimmerHalo);
    return this.group;
  }

  get litCount() { return this.beacons.filter((b) => b.lit).length; }

  nearestUnlit(p: THREE.Vector3) {
    let best: Beacon | null = null, bd = Infinity;
    const list = this.litCount === this.beacons.length && !this.finale.lit ? [this.finale] : this.beacons.filter((b) => !b.lit);
    for (const b of list) {
      const d = b.pos.distanceTo(p);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  update(dt: number, time: number, camera: THREE.Camera) {
    for (const b of [...this.beacons, this.finale]) {
      const rm = b.ring.material as THREE.ShaderMaterial;
      rm.uniforms.uProgress.value = b.progress;
      rm.uniforms.uActive.value += ((b.lit ? 0 : 1) - rm.uniforms.uActive.value) * Math.min(1, dt * 2);
      const since = b.litAt < 0 ? 0 : time - b.litAt;
      const intensity = b.lit ? Math.min(1, since * 1.5) * (1 + Math.max(0, 1 - since) * 1.5) : b.progress * 0.4;
      b.flame.visible = intensity > 0.01;
      b.flame.scale.setScalar(1.45 * (0.4 + Math.min(1, intensity) * 0.6 + Math.max(0, 1 - since) * 0.5 * (b.lit ? 1 : 0)));
      for (const m of b.flameMats) m.uniforms.uI.value = intensity;
      (b.pool.material as THREE.MeshBasicMaterial).opacity = (b.lit ? 0.75 : b.progress * 0.3) * (0.9 + Math.sin(time * 11 + b.pos.x) * 0.06 + Math.sin(time * 5.3) * 0.04);
      const mk = b.marker as THREE.Mesh;
      (mk.material as THREE.ShaderMaterial).uniforms.uA.value = b.lit ? Math.max(0, 1 - since) * 2 : 1;
    }
    // glimmers
    for (let i = 0; i < this.glimmers.length; i++) {
      const g = this.glimmers[i];
      let s = 1;
      if (g.taken) { g.t += dt; s = Math.max(0, 1 - g.t * 4) * (1 + g.t * 6); }
      this.dummy.position.copy(g.pos);
      this.dummy.position.y += Math.sin(time * 2 + i) * 0.18 + (g.taken ? g.t * 4 : 0);
      this.dummy.rotation.set(0, time * 1.8 + i, 0);
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      this.glimmerMesh.setMatrixAt(i, this.dummy.matrix);
      this.dummy.quaternion.copy(camera.quaternion);
      this.dummy.scale.setScalar(s * (1 + Math.sin(time * 4 + i) * 0.12));
      this.dummy.updateMatrix();
      this.glimmerHalo.setMatrixAt(i, this.dummy.matrix);
    }
    this.glimmerMesh.instanceMatrix.needsUpdate = true;
    this.glimmerHalo.instanceMatrix.needsUpdate = true;
  }
}

// Fading tyre tracks: a ring buffer of instanced quads laid on the ground.
import * as THREE from 'three';
import { uniforms } from '../world/assets';

export class Tracks {
  mesh: THREE.InstancedMesh;
  private birth: THREE.InstancedBufferAttribute;
  private strength: THREE.InstancedBufferAttribute;
  private i = 0;
  private max: number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(max = 900) {
    this.max = max;
    const g = new THREE.PlaneGeometry(0.34, 0.52);
    g.rotateX(-Math.PI / 2);
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(max).fill(-100), 1);
    this.strength = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aStrength', this.strength);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: true,
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: uniforms.uTime },
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        attribute float aBirth; attribute float aStrength; uniform float uTime;
        varying float vA; varying vec2 vUv;
        void main(){
          vUv = uv;
          float age = uTime - aBirth;
          vA = aStrength * (1.0 - smoothstep(3.0, 9.0, age));
          vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        varying float vA; varying vec2 vUv;
        void main(){
          float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x);
          float tread = 0.75 + 0.25 * step(0.5, fract(vUv.y * 4.0));
          gl_FragColor = vec4(vec3(0.16, 0.11, 0.14), vA * edge * tread * 0.4);
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(g, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < max; k++) this.mesh.setMatrixAt(k, zero);
  }

  add(p: THREE.Vector3, normal: THREE.Vector3, yaw: number, strength: number, time: number) {
    const k = this.i++ % this.max;
    this.q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    this.q2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.q.multiply(this.q2);
    this.m.compose(new THREE.Vector3(p.x, p.y + 0.03, p.z), this.q, this.s);
    this.mesh.setMatrixAt(k, this.m);
    (this.birth.array as Float32Array)[k] = time;
    (this.strength.array as Float32Array)[k] = strength;
    this.birth.needsUpdate = true;
    this.strength.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

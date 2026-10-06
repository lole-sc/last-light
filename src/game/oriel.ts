// Keeper Oriel: a small stylised figure with a star-gazer hat, a scarf that
// flutters in the wind and a lantern. She waves when Wick arrives.
import * as THREE from 'three';
import { Builder, M, MAT, cyl, ico, lathe, torus } from '../world/assets';
import { groundHeight } from '../world/terrain';

const COAT = 0x7c4a5e, SKIN = 0xf1c7a5, SCARF = 0xe0a53a, HAT = 0x2f8f8a, HAIR = 0xf4efe6, BOOT = 0x3a3346;

export class Oriel {
  root = new THREE.Group();
  private body = new THREE.Group();
  private head = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private scarfTail = new THREE.Group();
  lantern: THREE.Mesh;
  light = new THREE.PointLight(0xffb35c, 0, 10, 1.6);
  waving = 0;
  private t = 0;

  constructor(x: number, z: number) {
    const y = groundHeight(x, z);
    this.root.position.set(x, y, z);

    const coat = new Builder()
      .add(lathe([[0.0, 0], [0.52, 0.02], [0.48, 0.4], [0.36, 0.95], [0.26, 1.2], [0.0, 1.22]], 14), COAT, M(), { ao: 0.35 })
      .add(torus(0.5, 0.04, 4, 16), 0x5e3346, M(0, 0.06, 0, Math.PI / 2, 0, 0))
      .add(cyl(0.035, 0.035, 0.06, 6), 0xc99a3f, M(0, 0.85, 0.33, Math.PI / 2, 0, 0))
      .add(cyl(0.035, 0.035, 0.06, 6), 0xc99a3f, M(0, 0.65, 0.4, Math.PI / 2, 0, 0))
      .build();
    const coatMesh = new THREE.Mesh(coat, MAT.std);
    coatMesh.castShadow = true;
    const boots = new Builder()
      .add(ico(0.13, 1), BOOT, M(-0.17, 0.06, 0.12, 0, 0, 0, 1, 0.6, 1.4))
      .add(ico(0.13, 1), BOOT, M(0.17, 0.06, 0.12, 0, 0, 0, 1, 0.6, 1.4))
      .build();
    this.body.add(coatMesh, new THREE.Mesh(boots, MAT.std));

    // scarf
    const scarf = new THREE.Mesh(new Builder().add(torus(0.24, 0.09, 6, 14), SCARF, M(0, 0, 0, Math.PI / 2, 0, 0)).build(), MAT.std);
    scarf.position.y = 1.2;
    this.body.add(scarf);
    const tail = new THREE.Mesh(new Builder().add(new THREE.BoxGeometry(0.16, 0.5, 0.06), SCARF, M(0, -0.25, 0)).build(), MAT.std);
    this.scarfTail.add(tail);
    this.scarfTail.position.set(0.14, 1.2, -0.18);
    this.body.add(this.scarfTail);

    // head: face, white hair bun, rosy cheeks, the hat
    const h = new Builder()
      .add(new THREE.SphereGeometry(0.3, 16, 12), SKIN, M(0, 0, 0))
      .add(new THREE.SphereGeometry(0.31, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), HAIR, M(0, 0.02, -0.03, -0.35, 0, 0))
      .add(ico(0.14, 1), HAIR, M(0, 0.12, -0.3))
      .add(new THREE.SphereGeometry(0.035, 6, 4), 0x3a2030, M(-0.1, 0.03, 0.27))
      .add(new THREE.SphereGeometry(0.035, 6, 4), 0x3a2030, M(0.1, 0.03, 0.27))
      .add(new THREE.SphereGeometry(0.05, 6, 4), 0xf09a8a, M(-0.17, -0.05, 0.23, 0, 0, 0, 1, 0.6, 0.4))
      .add(new THREE.SphereGeometry(0.05, 6, 4), 0xf09a8a, M(0.17, -0.05, 0.23, 0, 0, 0, 1, 0.6, 0.4))
      .add(ico(0.045, 1), 0xe8a88a, M(0, -0.02, 0.3))
      .add(cyl(0.62, 0.62, 0.05, 20), HAT, M(0, 0.22, 0))
      .add(lathe([[0.3, 0], [0.24, 0.35], [0.12, 0.6], [0.02, 0.78], [0, 0.8]], 14), HAT, M(0, 0.23, 0, -0.15, 0, 0.1))
      .add(torus(0.29, 0.035, 4, 14), SCARF, M(0, 0.28, 0, Math.PI / 2, 0, 0))
      .add(ico(0.06, 0), 0xffe07a, M(0.08, 0.95, -0.12))
      .build();
    const headMesh = new THREE.Mesh(h, MAT.stdSmooth);
    headMesh.castShadow = true;
    this.head.add(headMesh);
    this.head.position.y = 1.5;
    this.body.add(this.head);

    // arms (pivot at the shoulder)
    const armGeo = new Builder()
      .add(cyl(0.08, 0.1, 0.55, 8), COAT, M(0, -0.27, 0))
      .add(ico(0.09, 1), SKIN, M(0, -0.58, 0))
      .build();
    for (const [arm, s] of [[this.armR, 1], [this.armL, -1]] as [THREE.Group, number][]) {
      const m = new THREE.Mesh(armGeo, MAT.std);
      m.castShadow = true;
      arm.add(m);
      arm.position.set(s * 0.3, 1.12, 0);
      arm.rotation.z = s * 0.25;
      this.body.add(arm);
    }
    // lantern in the left hand
    this.lantern = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 1), new THREE.MeshStandardMaterial({ color: 0x40301c, emissive: 0xffb347, emissiveIntensity: 3 }));
    const cage = new THREE.Mesh(new Builder()
      .add(cyl(0.11, 0.13, 0.04, 6), 0x3a3346, M(0, -0.12, 0))
      .add(cyl(0.02, 0.12, 0.08, 6), 0x3a3346, M(0, 0.14, 0))
      .add(torus(0.05, 0.012, 4, 8), 0x3a3346, M(0, 0.22, 0))
      .build(), MAT.std);
    const lanternG = new THREE.Group();
    lanternG.add(this.lantern, cage, this.light);
    lanternG.position.set(0, -0.82, 0.05);
    this.armL.add(lanternG);
    this.root.add(this.body);
    this.root.visible = false;
  }

  /** Make her look at a point and wave if it's close. */
  update(dt: number, look: THREE.Vector3, night: number) {
    if (!this.root.visible) return;
    this.t += dt;
    const t = this.t;
    const dx = look.x - this.root.position.x, dz = look.z - this.root.position.z;
    const d = Math.hypot(dx, dz);
    const yaw = Math.atan2(dx, dz);
    const cur = this.body.rotation.y;
    let diff = yaw - cur;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.body.rotation.y = cur + diff * Math.min(1, dt * 2.5);
    this.body.position.y = Math.abs(Math.sin(t * 2)) * 0.02;
    this.body.scale.y = 1 + Math.sin(t * 2.2) * 0.012;
    this.head.rotation.x = Math.sin(t * 0.7) * 0.05 - (d < 8 ? 0.12 : 0);
    this.head.rotation.z = Math.sin(t * 0.9) * 0.06;
    const wantWave = d < 22 ? 1 : 0;
    this.waving += (wantWave - this.waving) * Math.min(1, dt * 3);
    this.armR.rotation.z = 0.25 + this.waving * (2.5 + Math.sin(t * 9) * 0.35);
    this.armR.rotation.x = -this.waving * 0.2;
    this.armL.rotation.x = -0.25 + Math.sin(t * 1.3) * 0.05;
    this.scarfTail.rotation.x = 0.4 + Math.sin(t * 5) * 0.25;
    this.scarfTail.rotation.z = Math.sin(t * 3.7) * 0.2;
    (this.lantern.material as THREE.MeshStandardMaterial).emissiveIntensity = 3 + Math.sin(t * 13) * 0.3;
    this.light.intensity = 3 + night * 14;
  }
}

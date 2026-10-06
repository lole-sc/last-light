// WebGL2 renderer + post stack (bloom, diorama tilt-shift, grade, tone map)
// and HIGH / MEDIUM / LOW presets with auto-detection.
import * as THREE from 'three';
import {
  BlendFunction, BloomEffect, Effect, EffectComposer, EffectPass, KernelSize, RenderPass,
  TiltShiftEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing';

export type QualityName = 'high' | 'medium' | 'low';
export interface Preset { dpr: number; shadow: number; grass: number; msaa: number; tilt: boolean; shadowRadius: number; }
export const PRESETS: Record<QualityName, Preset> = {
  high: { dpr: 1.75, shadow: 4096, grass: 1, msaa: 4, tilt: true, shadowRadius: 3 },
  medium: { dpr: 1.35, shadow: 2048, grass: 0.6, msaa: 2, tilt: true, shadowRadius: 2 },
  low: { dpr: 1, shadow: 1024, grass: 0.3, msaa: 0, tilt: false, shadowRadius: 1 },
};

const gradeFrag = /* glsl */`
uniform vec3 uLift; uniform vec3 uGain; uniform float uSat; uniform float uExposure;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * uExposure;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  float sh = 1.0 - smoothstep(0.0, 0.6, l);
  c = c * uGain + uLift * sh;
  outputColor = vec4(max(c, 0.0), inputColor.a);
}`;

class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', gradeFrag, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uLift', new THREE.Uniform(new THREE.Vector3(0.012, 0.0, 0.03))],
        ['uGain', new THREE.Uniform(new THREE.Vector3(1.02, 1.0, 0.97))],
        ['uSat', new THREE.Uniform(1.12)],
        ['uExposure', new THREE.Uniform(1.0)],
      ]),
    });
  }
}

export function detectQuality(gl: WebGLRenderingContext | WebGL2RenderingContext): QualityName {
  try {
    const saved = localStorage.getItem('lastlight.quality');
    if (saved === 'high' || saved === 'medium' || saved === 'low') return saved;
  } catch { /* storage blocked */ }
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) as string;
  const n = (name || '').toLowerCase();
  if (/mobile|adreno|mali|powervr|swiftshader|llvmpipe/.test(n)) return 'low';
  if (/apple m\d|apple gpu|rtx|radeon rx|radeon pro|geforce gtx 1[06-9]|arc a/.test(n)) return 'high';
  if (/intel/.test(n)) return 'medium';
  return 'medium';
}

export class Renderer {
  renderer: THREE.WebGLRenderer;
  composer!: EffectComposer;
  bloom!: BloomEffect;
  tilt!: TiltShiftEffect;
  grade!: GradeEffect;
  tiltPass!: EffectPass;
  quality: QualityName = 'high';
  preset: Preset = PRESETS.high;
  /** dynamic resolution: fraction of the preset's max pixel ratio */
  dynScale = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
  }

  setup(scene: THREE.Scene, camera: THREE.PerspectiveCamera, quality: QualityName) {
    this.quality = quality;
    this.preset = PRESETS[quality];
    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: this.preset.msaa });
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomEffect({ intensity: 0.85, luminanceThreshold: 0.82, luminanceSmoothing: 0.25, mipmapBlur: true, radius: 0.7 });
    this.grade = new GradeEffect();
    this.tilt = new TiltShiftEffect({ focusArea: 0.62, feather: 0.36, offset: 0.04, kernelSize: KernelSize.SMALL, resolutionScale: 0.4 });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ darkness: 0.38, offset: 0.32 });
    this.composer.addPass(new EffectPass(camera, this.bloom));
    this.tiltPass = new EffectPass(camera, this.tilt);
    this.composer.addPass(this.tiltPass);
    this.composer.addPass(new EffectPass(camera, this.grade, tone, vignette));
    this.applyQuality(quality);
  }

  applyQuality(q: QualityName) {
    this.quality = q;
    this.preset = PRESETS[q];
    this.dynScale = 1;
    this.renderer.setPixelRatio(this.targetDpr());
    this.composer.multisampling = this.preset.msaa;
    this.tiltPass.enabled = this.preset.tilt;
    this.resize();
  }

  targetDpr() { return Math.max(0.75, Math.min(window.devicePixelRatio, this.preset.dpr) * this.dynScale); }

  /** Nudge the render resolution to hold the frame rate. Returns true if it changed. */
  adaptResolution(avgMs: number) {
    const before = this.dynScale;
    if (avgMs > 19) this.dynScale = Math.max(0.55, this.dynScale - 0.08);
    else if (avgMs < 14.5) this.dynScale = Math.min(1, this.dynScale + 0.04);
    if (Math.abs(before - this.dynScale) < 1e-3) return false;
    const pr = this.targetDpr();
    if (Math.abs(pr - this.renderer.getPixelRatio()) < 0.02) return false;
    this.renderer.setPixelRatio(pr);
    this.resize();
    return true;
  }

  /** Remember an explicit choice made by the player (auto-downgrades are not persisted). */
  persist(q: QualityName) {
    try { localStorage.setItem('lastlight.quality', q); } catch { /* ignore */ }
  }

  setExposure(e: number) { (this.grade.uniforms.get('uExposure') as THREE.Uniform).value = e; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h, false);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}

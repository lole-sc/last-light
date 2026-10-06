// Global shader hardening. Flat-shaded sliver triangles can yield a zero
// cross(dFdx, dFdy) → normalize() → NaN, and a single NaN pixel gets smeared
// across the whole frame by the bloom mip chain. Guard both ends.
import * as THREE from 'three';

let applied = false;
export function patchShaderChunks() {
  if (applied) return;
  applied = true;
  THREE.ShaderChunk.normal_fragment_begin = THREE.ShaderChunk.normal_fragment_begin.replace(
    'vec3 normal = normalize( cross( fdx, fdy ) );',
    'vec3 nrmCross = cross( fdx, fdy ); vec3 normal = dot( nrmCross, nrmCross ) > 1e-30 ? normalize( nrmCross ) : vec3( 0.0, 0.0, 1.0 );',
  );
  THREE.ShaderChunk.dithering_fragment += `
  // sanitize: no NaN / Inf may reach the HDR post chain
  if ( !( gl_FragColor.r == gl_FragColor.r && gl_FragColor.g == gl_FragColor.g && gl_FragColor.b == gl_FragColor.b ) ) gl_FragColor.rgb = vec3( 0.0 );
  gl_FragColor.rgb = clamp( gl_FragColor.rgb, 0.0, 48.0 );
`;
}

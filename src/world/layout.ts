// Hand-authored layout of the isle. Everything here is placed on purpose:
// +X = east, +Z = south (towards the default camera), Y = up.
import { smoothPath } from '../utils/math';

export const WATER_LEVEL = 0.15;
export const GRAVITY = -24;

/** Shoreline radius of the main island as a function of polar angle. */
export function islandRadius(th: number) {
  return 80 + 6 * Math.sin(3 * th + 0.7) + 4 * Math.sin(5 * th + 2.1) + 2.2 * Math.sin(11 * th + 0.3);
}

// ---------- Islets ----------
// The archipelago: the main isle plus three small islands floating around it.
export interface IsletDef { id: 'far' | 'observatory' | 'windward'; x: number; z: number; r: number; seed: number; angle: number; }
function isletAt(id: IsletDef['id'], angle: number, gap: number, r: number, seed: number): IsletDef {
  const d = islandRadius(angle) + gap + r;
  return { id, x: Math.cos(angle) * d, z: Math.sin(angle) * d, r, seed, angle };
}
export const ISLETS: IsletDef[] = [
  isletAt('far', 0.72, 22, 10.5, 1),
  isletAt('observatory', -2.33, 24, 12.5, 2),
  isletAt('windward', 0.0, 31, 11.5, 3),
];
export function isletRadiusOf(isl: IsletDef, th: number) {
  return isl.r + 1.1 * Math.sin(3 * th + isl.seed) + 0.7 * Math.sin(5 * th + 0.5 * isl.seed);
}

export const BRIDGE_WIDTH = 3.6;
export interface BridgeDef { id: string; a: { x: number; z: number }; b: { x: number; z: number }; angle: number; width: number; }
function bridgeTo(isl: IsletDef): BridgeDef {
  const rEdge = islandRadius(isl.angle);
  const dx = Math.cos(isl.angle), dz = Math.sin(isl.angle);
  return {
    id: isl.id,
    a: { x: dx * (rEdge - 3), z: dz * (rEdge - 3) },
    b: { x: isl.x - dx * (isl.r - 3), z: isl.z - dz * (isl.r - 3) },
    angle: isl.angle,
    width: BRIDGE_WIDTH,
  };
}
export const BRIDGES: BridgeDef[] = [bridgeTo(ISLETS[0]), bridgeTo(ISLETS[1])];

// legacy aliases (the first islet / bridge)
export const ISLET = ISLETS[0];
export const ISLET_R = ISLETS[0].r;
export const BRIDGE = { ...BRIDGES[0], y: 1.35 };
export const BRIDGE_ANGLE = ISLETS[0].angle;
export function isletRadius(th: number) { return isletRadiusOf(ISLETS[0], th); }
const dir = { x: Math.cos(BRIDGE_ANGLE), z: Math.sin(BRIDGE_ANGLE) };

export const OBSERVATORY = { x: ISLETS[1].x - 1.5, z: ISLETS[1].z - 2.5 };
export const ORIEL = { x: ISLETS[1].x + 3.2, z: ISLETS[1].z + 3.6 };
export const WINDWARD = ISLETS[2];

/** Wind geysers: step on the vent and the wind throws you across the gap. */
export interface GeyserDef { x: number; z: number; tx: number; tz: number; flight: number; }
export const GEYSERS: GeyserDef[] = [
  { x: 79, z: 1, tx: WINDWARD.x - 6, tz: 0.5, flight: 2.1 },
  { x: WINDWARD.x - 4, z: 6.5, tx: 71, tz: 8, flight: 2.3 },
];

// ---------- Landmarks ----------
export const PLAZA = { x: 4, z: 44 };
export const SPAWN = { x: 4, z: 41, yaw: Math.PI }; // facing north (-Z)
export const LIGHTHOUSE = { x: 0, z: -8 };
export const HILL = { x: 0, z: -8, r: 40, h: 9.5 };
export const WINDMILL = { x: 48, z: -38 };
export const WINDHILL = { x: 48, z: -38, r: 21, h: 5.5 };
export const RUINS = { x: -42, z: -44 };
export const ORCHARD = { x: 42, z: 18 };
export const POND = { x: -36, z: 8, rx: 15, rz: 11 };
export const HUT = { x: 15, z: 37, yaw: -0.5 };
export const CAMP = { x: -8, z: -73 };

export const STREAM: number[][] = smoothPath(
  [[-48, 10], [-55, 12.5], [-62, 12], [-69, 12.5], [-79, 13]],
  1.5,
);
/** Where the stream spills over the edge (for the waterfall). */
export const FALLS = (() => {
  const th = Math.atan2(13, -79);
  const r = islandRadius(th);
  return { x: Math.cos(th) * (r - 1.6), z: Math.sin(th) * (r - 1.6), dirX: Math.cos(th), dirZ: Math.sin(th) };
})();

// ---------- Roads ----------
function spiral(cx: number, cz: number, a0: number, a1: number, r0: number, r1: number, n: number) {
  const pts: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + (a1 - a0) * t;
    const r = r0 + (r1 - r0) * t;
    pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return pts;
}

export interface Road { pts: number[][]; width: number; }
const lighthouseRoad = [[4, 44], [3, 34], [2, 27], ...spiral(0, -8, 1.45, 1.45 - Math.PI * 2.05, 32, 7.5, 26)];

export const ROADS: Road[] = [
  { pts: smoothPath(lighthouseRoad, 2), width: 3.1 },
  { pts: smoothPath([[4, 44], [-8, 42], [-20, 34], [-23, 22], [-24, 8], [-27, -8], [-33, -24], [-41, -40]], 2), width: 3.1 },
  { pts: smoothPath([[-23, 22], [-36, 24], [-50, 22], [-58, 18], [-62, 8], [-63, -8], [-60, -24], [-50, -36], [-42, -43]], 2), width: 2.6 },
  { pts: smoothPath([[4, 44], [16, 42], [28, 32], [38, 22], [45, 8], [47, -8], [45, -20], [44, -30]], 2), width: 3.1 },
  { pts: smoothPath([[38, 22], [47, 31], [54, 40], [BRIDGE.a.x, BRIDGE.a.z]], 2), width: 2.6 },
  { pts: smoothPath([[-41, -44], [-30, -56], [-12, -64], [8, -66], [26, -58], [40, -44], [44, -32]], 2), width: 2.4 },
  { pts: smoothPath([[ISLET.x - dir.x * 7, ISLET.z - dir.z * 7], [ISLET.x, ISLET.z]], 2), width: 2.4 },
  // spur from the stone circle to the observatory bridge
  { pts: smoothPath([[-41, -44], [-47, -50], [BRIDGES[1].a.x, BRIDGES[1].a.z]], 2), width: 2.4 },
  { pts: smoothPath([[BRIDGES[1].b.x, BRIDGES[1].b.z], [ORIEL.x - 1, ORIEL.z - 1]], 2), width: 2.2 },
  // east trail to the wind geyser
  { pts: smoothPath([[47, -8], [60, -4], [72, 0], [GEYSERS[0].x - 2, GEYSERS[0].z]], 2), width: 2.4 },
];

/** Where the rim road crosses the stream: a little wooden bridge. */
export const STREAM_BRIDGE = { x: -61.4, z: 12.2, yaw: 0.08 };

// ---------- Objectives ----------
export interface BeaconDef { id: number; name: string; x: number; z: number; hint: string; }
export const BEACONS: BeaconDef[] = [
  { id: 0, name: 'Orchard Beacon', x: 51, z: 17, hint: 'among the fruit trees, east of the hut' },
  { id: 1, name: 'Windmill Beacon', x: 41, z: -31, hint: 'on the windy hill to the north-east' },
  { id: 2, name: 'Stone Circle Beacon', x: -42, z: -44, hint: 'inside the old stone circle' },
  { id: 3, name: 'Falls Beacon', x: -56, z: -1, hint: 'where the river falls into the sky' },
  { id: 4, name: 'Far Islet Beacon', x: ISLET.x + dir.x * 1.5, z: ISLET.z + dir.z * 1.5, hint: 'across the rope bridge, south-east' },
  { id: 5, name: 'Windward Beacon', x: WINDWARD.x + 3, z: WINDWARD.z - 2.5, hint: 'ride the wind geyser on the east rim' },
];
export const FINALE = { x: 0, z: -0.5 };

export interface NoteDef { x: number; z: number; yaw: number; title: string; body: string; }
export const NOTES: NoteDef[] = [
  { x: 9.5, z: 41.5, yaw: -0.4, title: "Keeper's log — the hut",
    body: 'Every evening the isle sinks a little lower into the clouds. Every evening, I light the five beacons and it floats up again. I am getting old, little Wick. Tonight it is your turn.' },
  { x: -27, z: 25, yaw: 0.6, title: 'A note pinned by the pond',
    body: 'The fish here only bite at dusk. Do not drive into the pond. (You will drive into the pond.)' },
  { x: 38, z: -29, yaw: -0.7, title: 'Windmill ledger',
    body: 'The mill still turns by itself. Nobody has ground flour here in forty years. I think it simply likes the wind.' },
  { x: -35, z: -38, yaw: 0.9, title: 'Scratched into a stone',
    body: 'Ring the bell and the stones remember. Ring it twice and they remember you.' },
  { x: BRIDGE.a.x - dir.x * 2 + dir.z * 3, z: BRIDGE.a.z - dir.z * 2 - dir.x * 3, yaw: -BRIDGE_ANGLE, title: 'Bridge warning',
    body: 'Rope bridge. One vehicle at a time. Do not look down. (There is no down. Only clouds.)' },
  { x: CAMP.x + 3.5, z: CAMP.z + 2.5, yaw: 0.3, title: "The keeper's secret camp",
    body: "You found my hiding place. From here you can see every beacon on the isle. When they are all burning, the lighthouse will answer. Go on. I'll watch from here." },
  { x: WINDWARD.x - 2, z: WINDWARD.z + 6, yaw: 1.2, title: 'Pinned to a pinwheel',
    body: 'The wind out here never stops. Oriel planted this garden so the geyser would have something to sing to. Hold on tight on the way back.' },
  { x: OBSERVATORY.x + 5, z: OBSERVATORY.z - 3, yaw: -0.6, title: "Oriel's star chart",
    body: 'A star fell tonight, just past the north rim. I am going to the observatory to see where it lands. If I am late, Wick, light the beacons for me. — O.' },
];

// Glimmers: optional floating sparks. [x, z, height above ground]
export const GLIMMERS: number[][] = [
  [2, 35, 1.2], [6, -15, 1.2], [-10, -13, 1.2], [-4, -24, 1.2],
  [-22.5, 8, 3.6], [-27.5, 8, 4.4], [-32.5, 8, 3.6],
  [-73, 12.8, 0.9], [-61.4, 12.2, -0.25],
  [-52, -18, 6.4], [-46, -40, 1.2], [CAMP.x, CAMP.z, 1.2], [14, -66, 1.2],
  [24.5, -46, 3.6], [29.5, -46, 4.6], [34.5, -46, 3.9],
  [56, -44, 1.2], [36, 10, 1.2], [53, 25, 1.2],
  [ISLET.x + 5, ISLET.z + 2, 1.2], [(BRIDGE.a.x + BRIDGE.b.x) / 2, (BRIDGE.a.z + BRIDGE.b.z) / 2, 2.2],
  [70, 10, 1.2], [-20, 56, 1.2], [28, 58, 1.2], [-60, 40, 1.2], [62, -12, 1.2],
  // the new islands
  [(BRIDGES[1].a.x + BRIDGES[1].b.x) / 2, (BRIDGES[1].a.z + BRIDGES[1].b.z) / 2, 2.2],
  [OBSERVATORY.x - 5, OBSERVATORY.z + 3, 1.2], [WINDWARD.x + 6, WINDWARD.z + 4, 1.2],
  [95, 0.8, 9.5], [105, 0.7, 11.5], // high in the geyser arc
  [WINDWARD.x - 1, WINDWARD.z - 7, 1.2],
];

// Jump ramps: position, yaw (direction of travel), with glimmer arcs above.
export const RAMPS = [
  { x: -16.5, z: 8, yaw: -Math.PI / 2 }, // launches west into the pond
  { x: 18, z: -46, yaw: Math.PI / 2 }, // launches east towards the windmill hill
];

export const MUSHROOMS = [
  { x: -52, z: -18, s: 1.15 },
  { x: -46.5, z: -25, s: 0.95 },
  { x: -56.5, z: -29, s: 1.3 },
];

/** Areas where terrain is flattened to its centre height (structures, beacons...). */
export const PADS: { x: number; z: number; r: number }[] = [
  { x: PLAZA.x, z: PLAZA.z, r: 11 },
  { x: HUT.x, z: HUT.z, r: 6 },
  ...BEACONS.map((b) => ({ x: b.x, z: b.z, r: 5 })),
  { x: RUINS.x, z: RUINS.z, r: 13 },
  { x: CAMP.x, z: CAMP.z, r: 6 },
  ...BRIDGES.flatMap((b) => [{ x: b.a.x, z: b.a.z, r: 5 }, { x: b.b.x, z: b.b.z, r: 5 }]),
  ...GEYSERS.map((g) => ({ x: g.x, z: g.z, r: 4.5 })),
  { x: OBSERVATORY.x, z: OBSERVATORY.z, r: 7 },
];

/** Areas kept free of trees / grass clumps. */
export const CLEARINGS: { x: number; z: number; r: number }[] = [
  { x: PLAZA.x, z: PLAZA.z, r: 12 },
  { x: HUT.x, z: HUT.z, r: 6 },
  { x: LIGHTHOUSE.x, z: LIGHTHOUSE.z, r: 7 },
  { x: WINDMILL.x, z: WINDMILL.z, r: 7 },
  { x: RUINS.x, z: RUINS.z, r: 12 },
  { x: CAMP.x, z: CAMP.z, r: 5 },
  ...BEACONS.map((b) => ({ x: b.x, z: b.z, r: 5 })),
  ...RAMPS.map((r) => ({ x: r.x, z: r.z, r: 6 })),
  ...MUSHROOMS.map((m) => ({ x: m.x, z: m.z, r: 3.5 * m.s })),
  ...NOTES.map((n) => ({ x: n.x, z: n.z, r: 1.5 })),
  ...GEYSERS.map((g) => ({ x: g.x, z: g.z, r: 5 })),
  ...GEYSERS.map((g) => ({ x: g.tx, z: g.tz, r: 7 })),
  ...BRIDGES.flatMap((b) => [{ x: b.a.x, z: b.a.z, r: 4 }, { x: b.b.x, z: b.b.z, r: 4 }]),
  { x: OBSERVATORY.x, z: OBSERVATORY.z, r: 7.5 },
  { x: ORIEL.x, z: ORIEL.z, r: 3 },
];

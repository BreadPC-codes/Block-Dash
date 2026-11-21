// Shared dimensions for the motorcycle, in "bike space":
// origin on the ground midway between the axles (at static sag), +Z forward, +Y up, +X left.
// Physics and both the procedural and imported visual models use these numbers, so the
// rendered wheels always line up with the simulated contact patches.

const DEG = Math.PI / 180;

export const GEO = {
  wheelbase: 1.48,
  rearAxle: [0, 0.345, -0.74],
  frontAxle: [0, 0.358, 0.74],
  rRear: 0.345,
  rFront: 0.358,
  tubeRear: 0.065,
  tubeFront: 0.05,
  rimRear: 0.229, // 18" rim radius
  rimFront: 0.267, // 21" rim radius
  rake: 27 * DEG,
  // steering axis passes through the front axle at static sag
  steerTop: [0, 1.02, 0.4],
  swingPivot: [0, 0.5, -0.16],
  travelF: 0.3,
  travelR: 0.31,
  sagF: 0.075,
  sagR: 0.1,
  massBike: 104,
  massRider: 76,
  comBike: [0, 0.6, 0.04],
  riderSeated: [0, 1.04, -0.14],
  riderStanding: [0, 1.2, -0.1],
  seat: [0, 0.96, -0.26],
  pegs: [0.19, 0.37, -0.1], // mirrored in X
  grips: [0.4, 1.07, 0.32], // mirrored in X
  headSeated: [0, 1.5, -0.1],
  headStanding: [0, 1.67, 0.04],
};

export function v3(arr) {
  return { x: arr[0], y: arr[1], z: arr[2] };
}

/** Unit suspension axes in bike space (direction the wheel moves when compressing). */
export const AXIS_FRONT = [0, Math.cos(GEO.rake), -Math.sin(GEO.rake)];
export const AXIS_REAR = (() => {
  // perpendicular to the swingarm, pointing up
  const dy = GEO.rearAxle[1] - GEO.swingPivot[1];
  const dz = GEO.rearAxle[2] - GEO.swingPivot[2];
  const len = Math.hypot(dy, dz);
  // tangent of rotation with positive Y component
  let ty = -dz / len, tz = dy / len;
  if (ty < 0) { ty = -ty; tz = -tz; }
  return [0, ty, tz];
})();

export const SWINGARM_LENGTH = Math.hypot(GEO.rearAxle[1] - GEO.swingPivot[1], GEO.rearAxle[2] - GEO.swingPivot[2]);

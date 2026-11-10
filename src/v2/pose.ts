/* Re-shoot: a camera pose around the subject (az: degrees around, negative = left;
   el: height) and interpolation of a start → end move. Kept outside Scene3D so
   the view can use it without loading three.js. */
export interface Pose { az: number; el: number }
export const lisser = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
export function poseA(cles: Pose[] | null, statique: Pose, t: number): Pose {
  if (!cles || cles.length < 2) return statique
  const k = lisser(Math.max(0, Math.min(1, t)))
  return { az: cles[0].az + (cles[1].az - cles[0].az) * k, el: cles[0].el + (cles[1].el - cles[0].el) * k }
}

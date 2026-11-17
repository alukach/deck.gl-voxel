import type { VoxelData } from 'deck.gl-voxel';

/**
 * Linearly blends two frames of the same grid.
 * A cell that is missing in either frame takes the nearer frame's value instead of a blend.
 * @param from - Frame at t = 0.
 * @param to - Frame at t = 1. Must have the same dimensions as `from`.
 * @param t - Blend position from 0 to 1.
 * @param out - Reusable array of the same length. Overwritten.
 * @returns A volume that shares `from`'s geometry and uses `out` for its values.
 */
export function blendFrames(
  from: VoxelData,
  to: VoxelData,
  t: number,
  out: Float32Array,
): VoxelData {
  const { values: a } = from;
  const { values: b } = to;
  const nodata = from.noDataValue;
  const missing = (v: number) => !Number.isFinite(v) || v === nodata;

  for (let i = 0; i < out.length; i++) {
    const x = a[i] ?? Number.NaN;
    const y = b[i] ?? Number.NaN;
    out[i] = missing(x) || missing(y) ? (t < 0.5 ? x : y) : x + (y - x) * t;
  }

  return { ...from, values: out };
}

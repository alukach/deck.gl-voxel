import type { Viewport } from '@deck.gl/core';
import { Matrix4 } from '@math.gl/core';
import type { Vector3, VoxelData } from 'deck.gl-voxel';

/** The volume sample shown in the hover tooltip. */
export interface VolumeSample {
  /** Sampled value in the dataset's units, such as m/s for wind speed. */
  readonly value: number;

  /** Physical altitude in meters before vertical exaggeration. */
  readonly altitudeMeters: number;
}

/**
 * Traces a line from the camera through the cursor into the volume. A pixel can mix several
 * depths, so report the point where the samples first add up to 10% opacity.
 * The pointer comes in CSS pixels. Convert it to the camera's -1 to 1 X and Y range
 * to find the near and far points of that line. Flip Y because CSS pixels count downward.
 *
 * @param volume - Grid currently drawn in Web Mercator coordinates.
 * @param viewport - Current deck.gl camera and view size in CSS pixels.
 * @param pixel - Pointer position in CSS pixels from the upper left.
 * @param modelMatrix - The display transform, including the height stretch.
 * @param transferFunction - Color table with opacity chosen by data value.
 * @param valueRange - Data values for the first and last table entries.
 * @param density - How quickly opacity builds up in the displayed volume.
 * @returns A sample for the tooltip, or undefined when opacity stays below 10%.
 */
export function pickVolumeSample(
  volume: VoxelData,
  viewport: Viewport,
  pixel: readonly [number, number],
  modelMatrix: Matrix4,
  transferFunction: Uint8Array,
  valueRange: readonly [number, number],
  density: number,
): VolumeSample | undefined {
  const { origin, spacing, dimensions } = volume;

  if (!origin || !spacing || density === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return undefined;
  }

  const extent: Vector3 = [
    dimensions[0] * spacing[0],
    dimensions[1] * spacing[1],
    dimensions[2] * spacing[2],
  ];
  const clipToGrid = new Matrix4(viewport.viewProjectionMatrix)
    .multiplyRight(modelMatrix)
    .translate(origin)
    .scale(extent)
    .invert();
  const screenX = (2 * pixel[0]) / viewport.width - 1;
  const screenY = 1 - (2 * pixel[1]) / viewport.height;
  const near = clipToGrid.transformAsPoint([screenX, screenY, -1]);
  const far = clipToGrid.transformAsPoint([screenX, screenY, 1]);
  const [x = NaN, y = NaN, z = NaN] = near;
  const [farX = NaN, farY = NaN, farZ = NaN] = far;
  const direction: Vector3 = [farX - x, farY - y, farZ - z];

  if (![x, y, z, ...direction].every(Number.isFinite)) {
    return undefined;
  }

  const interval = intersectGrid([x, y, z], direction);

  if (!interval) {
    return undefined;
  }

  const [entry, exit] = interval;
  const voxelsPerUnit = Math.hypot(
    direction[0] * dimensions[0],
    direction[1] * dimensions[1],
    direction[2] * dimensions[2],
  );
  const opacityUnitsPerStep =
    Math.hypot(direction[0] * extent[0], direction[1] * extent[1], direction[2] * extent[2]) /
    Math.abs(spacing[2]);
  const maxSteps = 2048;
  const step = Math.max(0.5 / voxelsPerUnit, (exit - entry) / maxSteps);
  const last = transferFunction.length / 4 - 1;
  let opacity = 0;
  let t = entry;

  for (let index = 0; index < maxSteps && t < exit; index++) {
    const distance = Math.min(step, exit - t);
    const middle = t + distance / 2;
    const position: Vector3 = [
      x + direction[0] * middle,
      y + direction[1] * middle,
      z + direction[2] * middle,
    ];
    const value = sampleValue(volume, position);

    if (value !== undefined) {
      const normalized = (value - valueRange[0]) / (valueRange[1] - valueRange[0]);
      const coordinate = Math.max(0, Math.min(1, normalized)) * last;
      const lower = Math.floor(coordinate);
      const a = transferFunction[4 * lower + 3] ?? 0;
      const b = transferFunction[4 * Math.min(lower + 1, last) + 3] ?? 0;
      const alpha = (a + (b - a) * (coordinate - lower)) / 255;

      opacity += (1 - opacity) * (1 - (1 - alpha) ** (distance * opacityUnitsPerStep * density));

      if (opacity >= 0.1) {
        const [, south] = viewport.unprojectFlat([origin[0], origin[1]]);
        const [, north] = viewport.unprojectFlat([origin[0], origin[1] + extent[1]]);
        const { metersPerUnit } = viewport.getDistanceScales([0, (south + north) / 2]);
        const verticalScale = metersPerUnit[2];

        if (verticalScale === undefined) {
          return undefined;
        }

        return {
          value,
          altitudeMeters: (origin[2] + position[2] * extent[2]) * verticalScale,
        };
      }
    }

    t += distance;
  }

  return undefined;
}

/**
 * Finds where the line from the camera enters and leaves the grid.
 * @param origin - Near point in 0-to-1 grid coordinates.
 * @param direction - Vector from the near point to the far point.
 * @returns Entry and exit as fractions of the whole line, or undefined if it misses the grid.
 */
function intersectGrid(origin: Vector3, direction: Vector3): readonly [number, number] | undefined {
  let entry = 0;
  let exit = 1;

  for (const axis of [0, 1, 2] as const) {
    if (Math.abs(direction[axis]) < 1e-10) {
      if (origin[axis] < 0 || origin[axis] > 1) {
        return undefined;
      }
    } else {
      const a = -origin[axis] / direction[axis];
      const b = (1 - origin[axis]) / direction[axis];

      entry = Math.max(entry, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
    }
  }

  return exit > entry ? [entry, exit] : undefined;
}

/**
 * Blends up to eight nearby cells. If any are missing, the cells with data get all the weight.
 * @param volume - Grid whose flat array changes X fastest.
 * @param position - Position in 0-to-1 grid coordinates.
 * @returns The blended value, or undefined when all neighbors with weight are missing.
 */
function sampleValue(volume: VoxelData, position: Vector3): number | undefined {
  const [width, height, depth] = volume.dimensions;
  const px = position[0] * width - 0.5;
  const py = position[1] * height - 0.5;
  const pz = position[2] * depth - 0.5;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const z0 = Math.floor(pz);
  const fx = px - x0;
  const fy = py - y0;
  const fz = pz - z0;
  let sum = 0;
  let weight = 0;

  for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        const ix = Math.max(0, Math.min(width - 1, x0 + x));
        const iy = Math.max(0, Math.min(height - 1, y0 + y));
        const iz = Math.max(0, Math.min(depth - 1, z0 + z));
        const value = volume.values[ix + width * (iy + height * iz)];
        const w = (x === 0 ? 1 - fx : fx) * (y === 0 ? 1 - fy : fy) * (z === 0 ? 1 - fz : fz);

        if (value !== undefined && Number.isFinite(value) && value !== volume.noDataValue) {
          sum += value * w;
          weight += w;
        }
      }
    }
  }

  return weight > 1e-8 ? sum / weight : undefined;
}

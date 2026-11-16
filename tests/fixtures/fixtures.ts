import type { VoxelData } from 'deck.gl-voxel';

/** Made-up data patterns used by the browser checks. */
export type FixtureKind = 'field' | 'axes' | 'missing' | 'constant';

/** Test value that marks a missing cell. Zero still counts as valid data. */
const NO_DATA_VALUE = -9999;

/**
 * Creates a grid with different cell counts and cell sizes on each axis. This makes a
 * swapped axis easier to spot. X changes fastest in the flat array. The axis test puts
 * a red, green or blue marker near the positive end of X, Y or Z respectively.
 *
 * @param kind - Test pattern. The default changes smoothly from the center outward.
 * @returns A newly allocated grid spanning 48 by 40 by 36 layer units.
 */
export function createFixture(kind: FixtureKind = 'field'): VoxelData {
  const dimensions = [48, 32, 24] as const;
  const values = new Float32Array(dimensions[0] * dimensions[1] * dimensions[2]);

  for (let z = 0; z < dimensions[2]; z++) {
    for (let y = 0; y < dimensions[1]; y++) {
      for (let x = 0; x < dimensions[0]; x++) {
        const u = (x + 0.5) / dimensions[0];
        const v = (y + 0.5) / dimensions[1];
        const w = (z + 0.5) / dimensions[2];
        const index = x + dimensions[0] * (y + dimensions[1] * z);

        values[index] = sampleFixture(kind, u, v, w);
      }
    }
  }

  return {
    values,
    dimensions,
    origin: [-24, -20, -18],
    spacing: [1, 1.25, 1.5],
    noDataValue: NO_DATA_VALUE,
  };
}

/**
 * Builds a color table that makes the axis markers or the smooth field easy to see.
 *
 * @param kind - Test pattern to color.
 * @returns A new 256-entry table with four bytes per color for RGBA.
 */
export function createLut(kind: FixtureKind): Uint8Array {
  const table = new Uint8Array(256 * 4);

  for (let index = 0; index < 256; index++) {
    const value = index / 255;

    if (kind === 'axes') {
      table.set(getAxisColor(value), index * 4);
    } else {
      table.set(
        [
          Math.round(value * 255),
          Math.round(80 + value * 150),
          Math.round(255 - value * 150),
          Math.round(value * 25),
        ],
        index * 4,
      );
    }
  }

  return table;
}

/**
 * Calculates the test value at a cell center.
 *
 * @param kind - Pattern to evaluate.
 * @param x - Normalized X coordinate in [0, 1].
 * @param y - Normalized Y coordinate in [0, 1].
 * @param z - Normalized Z coordinate in [0, 1].
 * @returns The test value, or NaN or NO_DATA_VALUE for a missing cell.
 */
function sampleFixture(kind: FixtureKind, x: number, y: number, z: number): number {
  switch (kind) {
    case 'constant':
      return 0.6;

    case 'missing':
      return x > 0.45 && x < 0.55 ? NO_DATA_VALUE : 0.6;

    case 'axes':
      if (x > 0.75 && y < 0.25 && z < 0.25) {
        return 0;
      }

      if (y > 0.75 && x < 0.25 && z < 0.25) {
        return 0.5;
      }

      if (z > 0.75 && x < 0.25 && y < 0.25) {
        return 1;
      }

      return Number.NaN;

    case 'field': {
      const squaredRadius = ((x - 0.5) * 2) ** 2 + ((y - 0.5) * 2) ** 2 + ((z - 0.5) * 2) ** 2;

      return Math.max(0, 1 - squaredRadius);
    }
  }
}

/**
 * Assigns red, green, or blue to the three axis-marker scalar values.
 *
 * @param value - Position in the color table from 0 to 1.
 * @returns An opaque RGBA8 color.
 */
function getAxisColor(value: number): readonly [number, number, number, number] {
  if (value < 0.25) {
    return [255, 40, 40, 255];
  }

  if (value < 0.75) {
    return [40, 255, 80, 255];
  }

  return [40, 100, 255, 255];
}

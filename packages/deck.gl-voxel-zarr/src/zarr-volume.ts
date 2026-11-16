import type { Vector3, VoxelData } from 'deck.gl-voxel';
import { type Chunk, FetchStore, get, open, root, withRangeCoalescing } from 'zarrita';

import { createProjectedGrid, projectFrame } from './projected-grid.js';

/** Labels for the stored array's dimensions. */
export type Axis = 'x' | 'y' | 'z' | 'time';

/** Describes how to place a plain Zarr array in 3D. */
export interface ZarrVolumeLayout {
  /**
   * One label per dimension in the order used by the store. For example, an array shaped
   * [hours, levels, rows, columns] uses ['time', 'z', 'y', 'x']. Include X, Y and Z once each.
   */
  readonly axes: readonly Axis[];

  /** The starting corner of the grid in XYZ order. This order stays fixed even if axes differ. */
  readonly origin: Vector3;

  /** Cell sizes in XYZ order. A negative size flips an axis. Use local units unless crs is set. */
  readonly spacing: Vector3;

  /**
   * Set to EPSG:4326 for a north-up longitude and latitude grid. X and Y then use degrees.
   * Z uses meters and increases upward. The reader puts the grid on a Web Mercator map.
   * @default Local Cartesian coordinates
   */
  readonly crs?: 'EPSG:4326';
}

/** Selects a Zarr array and describes its grid. */
export interface ZarrVolumeOptions {
  /** Path to the array inside the store. Use '.' for the root. */
  readonly field: string;

  /** Grid geometry for the array. */
  readonly layout: ZarrVolumeLayout;

  /**
   * Maximum number of cells in one frame. Zarr stores data in blocks called chunks.
   * A chunk can include several times, so even a read for one frame can download extra data.
   * @default 2000000
   */
  readonly maxCells?: number;

  /** Cancels metadata and coordinate reads. Frame reads accept their own signal. */
  readonly signal?: AbortSignal;
}

/** An open field that can read one time step at a time. */
export interface ZarrVolume {
  /** Number of frames. An array with no time axis has one frame. */
  readonly frameCount: number;

  /**
   * Reads the whole grid for one time step. The returned array stores one X row after
   * another, then one XY plane after another along Z. Map grids use deck.gl's Web Mercator
   * coordinates.
   * @param index - Zero-based time index. Use zero for a field with no time axis.
   * @param signal - Cancels the read.
   * @returns A new array of values and the geometry needed to draw its cells.
   * @throws {Error} If the index is invalid or the read fails. Aborts reject with the signal reason.
   */
  readFrame(index: number, signal?: AbortSignal): Promise<VoxelData>;
}

const DEFAULT_MAX_CELLS = 2_000_000;

/**
 * Opens a float32 volume from a Zarr v2 or v3 store. This reads metadata and any needed
 * coordinates. Call readFrame to fetch the data values.
 *
 * @param url - HTTP(S) store root. Cross-origin reads require CORS.
 * @param options - Field, grid geometry and frame size limit.
 * @returns A reader that fetches the stored blocks needed for each requested frame.
 * @throws {Error} If the field, geometry, or selected frame size is unsupported.
 * @see https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html
 */
export async function openZarrVolume(url: string, options: ZarrVolumeOptions): Promise<ZarrVolume> {
  const { field, layout, signal } = options;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;

  if (!Number.isSafeInteger(maxCells) || maxCells < 1) {
    throw new Error('maxCells must be a positive safe integer.');
  }

  const location = root(withRangeCoalescing(new FetchStore(url, { useSuffixRequest: true })));
  const openOptions = signal ? { signal } : {};
  const array = await open(location.resolve(field), { ...openOptions, kind: 'array' });

  if (!array.is('float32')) {
    throw new Error('Expected a float32 Zarr array.');
  }

  const { axes } = layout;
  const { dimensions, frameCount } = getFrameShape(array.shape, axes, maxCells);
  const [width, height, depth] = dimensions;
  const grid = preparePlainGrid(layout, dimensions);
  const scalar = array;
  const fillValue = scalar.attrs._FillValue;
  const noDataValue = typeof fillValue === 'number' ? Math.fround(fillValue) : undefined;
  const spatialAxes = axes.filter((axis) => axis !== 'time');
  const xAxis = spatialAxes.indexOf('x');
  const yAxis = spatialAxes.indexOf('y');
  const zAxis = spatialAxes.indexOf('z');

  return {
    frameCount,
    /** {@inheritDoc ZarrVolume.readFrame} */
    async readFrame(index: number, frameSignal?: AbortSignal): Promise<VoxelData> {
      if (!Number.isSafeInteger(index) || index < 0 || index >= frameCount) {
        throw new Error('Time index is outside the Zarr field.');
      }

      frameSignal?.throwIfAborted();

      const selection = axes.map((axis) => (axis === 'time' ? index : null));
      const frame = await get(scalar, selection, frameSignal ? { signal: frameSignal } : {});
      const strideZ = frame.stride[zAxis];
      const strideY = frame.stride[yAxis];
      const strideX = frame.stride[xAxis];

      frameSignal?.throwIfAborted();

      if (strideZ === undefined || strideY === undefined || strideX === undefined) {
        throw new Error('Decoded Zarr frame does not have three spatial axes.');
      }

      const normalized: Chunk<'float32'> = {
        data: frame.data,
        shape: [depth, height, width],
        stride: [strideZ, strideY, strideX],
      };

      if (grid) {
        return projectFrame(normalized, grid, noDataValue);
      }

      return {
        values: copyToGridOrder(normalized, dimensions),
        dimensions,
        origin: layout.origin,
        spacing: layout.spacing,
        ...(noDataValue !== undefined && { noDataValue }),
      };
    },
  };
}

/**
 * Finds the grid size and checks its cell count before downloading data values.
 * @param shape - Lengths of the array dimensions in storage order.
 * @param axes - Labels for those dimensions in the same order.
 * @param maxCells - Maximum cells in one frame.
 * @returns Validated XYZ dimensions and time length.
 * @throws {Error} If the array shape, axis mapping, or frame size is unsupported.
 */
function getFrameShape(
  shape: readonly number[],
  axes: readonly Axis[],
  maxCells: number,
): { dimensions: Vector3; frameCount: number } {
  const width = shape[axes.indexOf('x')];
  const height = shape[axes.indexOf('y')];
  const depth = shape[axes.indexOf('z')];
  const timeAxis = axes.indexOf('time');
  const frameCount = timeAxis === -1 ? 1 : shape[timeAxis];

  if (
    axes.length !== shape.length ||
    axes.length !== (timeAxis === -1 ? 3 : 4) ||
    width === undefined ||
    height === undefined ||
    depth === undefined ||
    frameCount === undefined ||
    !shape.every((size) => Number.isSafeInteger(size) && size > 0)
  ) {
    throw new Error('Expected three spatial axes and at most one time axis.');
  }

  const cells = width * height * depth;

  if (!Number.isSafeInteger(cells) || cells > maxCells) {
    throw new Error(`Zarr frame requires ${cells} cells; maxCells is ${maxCells}.`);
  }

  return { dimensions: [width, height, depth], frameCount };
}

/**
 * Checks the grid geometry and works out where to read source cells for the map.
 * @param layout - Grid corner and signed cell sizes in XYZ order.
 * @param dimensions - Cell counts in X, Y, Z order.
 * @returns Geometry and source lookups for a geographic grid, or undefined for a local grid.
 * @throws {Error} If the geometry is invalid or the geographic grid is unsupported.
 */
function preparePlainGrid(
  layout: ZarrVolumeLayout,
  [width, height, depth]: Vector3,
): ReturnType<typeof createProjectedGrid> | undefined {
  const { crs, origin, spacing } = layout;

  if (
    origin.length !== 3 ||
    !origin.every(Number.isFinite) ||
    spacing.length !== 3 ||
    !spacing.every((size) => Number.isFinite(Math.fround(size)) && Math.fround(size) !== 0)
  ) {
    throw new Error('Zarr layout requires a finite XYZ origin and finite, nonzero XYZ spacing.');
  }

  if (crs === undefined) {
    return undefined;
  }

  if (crs !== 'EPSG:4326') {
    throw new Error('The geographic Zarr layout supports EPSG:4326.');
  }

  return createProjectedGrid(
    {
      affine: [spacing[0], 0, origin[0], 0, spacing[1], origin[1]],
      arrayWidth: width,
      arrayHeight: height,
    },
    { count: depth, origin: origin[2], spacing: spacing[2] },
  );
}

/**
 * Arranges the flat array so adjacent entries move along X. Reuses an array already in that order.
 * @param frame - Decoded frame. A stride is how far to advance in the array to move one cell
 * along an axis. If X changes fastest and there are 64 X cells, the Y stride is 64.
 * @param dimensions - Cell counts in X, Y, Z order.
 * @returns The decoded values in grid order.
 */
function copyToGridOrder(frame: Chunk<'float32'>, [width, height, depth]: Vector3): Float32Array {
  const [strideZ = 0, strideY = 0, strideX = 0] = frame.stride;

  if (strideX === 1 && strideY === width && strideZ === width * height) {
    return frame.data;
  }

  const values = new Float32Array(width * height * depth);

  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        values[x + width * (y + height * z)] =
          frame.data[x * strideX + y * strideY + z * strideZ] ?? Number.NaN;
      }
    }
  }

  return values;
}

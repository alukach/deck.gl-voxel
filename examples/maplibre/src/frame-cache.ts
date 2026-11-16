import type { VoxelData } from 'deck.gl-voxel';

import type { VolumeReader } from './datasets.js';

/** Keeps decoded frames and shares in-flight reads for one dataset. */
export class FrameCache {
  private readonly reader: VolumeReader;
  private readonly frames = new Map<number, VoxelData>();
  private readonly pending = new Map<number, { signal: AbortSignal; frame: Promise<VoxelData> }>();

  /**
   * Starts an empty cache for an open dataset.
   * @param reader - Source of the frames in this dataset.
   */
  constructor(reader: VolumeReader) {
    this.reader = reader;
  }

  /** Number of frames in the dataset. */
  get frameCount(): number {
    return this.reader.frameCount;
  }

  /** Whether every frame is ready to play from memory. */
  get isComplete(): boolean {
    return this.frames.size === this.frameCount;
  }

  /**
   * Checks if a frame is already in memory.
   * @param index - Zero-based frame index.
   * @returns Whether the frame can be drawn without fetching it.
   */
  has(index: number): boolean {
    return this.frames.has(index);
  }

  /**
   * Gets a frame from memory, shares an active read or starts a read.
   * @param index - Zero-based frame index.
   * @param signal - Cancels this caller's request.
   * @returns The decoded frame.
   * @throws {Error} If the read fails or this request is canceled.
   */
  async read(index: number, signal: AbortSignal): Promise<VoxelData> {
    signal.throwIfAborted();
    const cached = this.frames.get(index);

    if (cached) {
      return cached;
    }

    const pending = this.pending.get(index);

    if (pending && !pending.signal.aborted) {
      try {
        const frame = await pending.frame;
        signal.throwIfAborted();
        return frame;
      } catch (error) {
        signal.throwIfAborted();

        if (!pending.signal.aborted) {
          throw error;
        }

        return this.read(index, signal);
      }
    }

    const frame = this.reader.readFrame(index, signal).then((result) => {
      signal.throwIfAborted();
      this.frames.set(index, result);
      return result;
    });
    this.pending.set(index, { signal, frame });

    try {
      return await frame;
    } finally {
      if (this.pending.get(index)?.frame === frame) {
        this.pending.delete(index);
      }
    }
  }
}

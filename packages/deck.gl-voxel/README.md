# deck.gl-voxel

Experimental deck.gl layer for visualizing volumetric data with WebGPU.

## Example

```ts
import { Deck, OrbitView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { VoxelLayer } from 'deck.gl-voxel';

const deck = new Deck({
  canvas: 'volume',
  deviceProps: {
    type: 'webgpu',
    adapters: [webgpuAdapter],
  },
  views: new OrbitView({ orbitAxis: 'Z' }),
  initialViewState: { target: [0, 0, 0], rotationX: 25, rotationOrbit: 25, zoom: 3 },
  controller: true,
  layers: [
    new VoxelLayer({
      id: 'density',
      volume: {
        values: new Float32Array(16 * 12 * 8).fill(0.5),
        dimensions: [16, 12, 8],
        origin: [-8, -6, -8],
        spacing: [1, 1, 2],
      },
    }),
  ],
});
```

## Rendering

- `volume` shows the grid’s interior (increase `density` to make it less transparent)
- `isosurface` draws a surface where the data reaches `isovalue`

See the [layer props](src/types.ts) and the [MapLibre example](../../examples/maplibre/README.md).

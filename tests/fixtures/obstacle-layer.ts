import { Layer, type LayerContext } from '@deck.gl/core';
import { Buffer, type RenderPass } from '@luma.gl/core';
import { Model } from '@luma.gl/engine';

/** Solid plane through the center of the volume. The test checks that it hides what's behind it. */
export class ObstacleLayer extends Layer {
  static override layerName = 'ObstacleLayer';

  declare state: { model: Model; uniform: Buffer };

  /** Creates the model for the plane and the GPU buffer that holds its camera transform. */
  override initializeState(): void {
    this.getAttributeManager()?.remove(['instancePickingColors']);

    const uniform = this.context.device.createBuffer({
      byteLength: 64,
      usage: Buffer.UNIFORM | Buffer.COPY_DST,
    });

    const model = new Model(this.context.device, {
      source: /* wgsl */ `
        @group(0) @binding(0) var<uniform> transform: mat4x4f;
  /** Draws a plane made of two triangles using the current view's camera. */
        @vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          var positions = array<vec2f, 6>(
            vec2f(-30, -30), vec2f(30, -30), vec2f(-30, 30),
            vec2f(-30, 30), vec2f(30, -30), vec2f(30, 30),
          );

          return transform * vec4f(positions[i].x, 0.0, positions[i].y, 1.0);
        }
        /** Supplies an opaque gray surface for color and depth checks. */
        @fragment fn fragmentMain() -> @location(0) vec4f {
          return vec4f(0.65, 0.65, 0.65, 1.0);
        }
      `,
      vertexCount: 6,
      bindings: { transform: uniform },
      shaderLayout: {
        attributes: [],
        bindings: [{ name: 'transform', type: 'uniform', group: 0, location: 0 }],
      },
    });

    this.setState({ model, uniform });
  }

  /** The test shader gets its camera transform directly from the buffer. */
  override setShaderModuleProps(): void {}

  /**
   * Draws the same plane when capturing depth and when drawing the visible scene.
   *
   * @param options - Draw context supplied by deck.gl.
   * @param options.renderPass - Active render pass supplied by deck.gl.
   */
  override draw({ renderPass }: { renderPass: RenderPass }): void {
    this.state.uniform.write(new Float32Array(this.context.viewport.viewProjectionMatrix));
    this.state.model.draw(renderPass);
  }

  /**
   * Frees the camera settings buffer before the base layer frees the model.
   *
   * @param context - Framework cleanup context.
   */
  override finalizeState(context: LayerContext): void {
    this.state.uniform.destroy();
    super.finalizeState(context);
  }
}

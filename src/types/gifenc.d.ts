// gifenc は型定義を同梱していないため、実際に使用している範囲だけの最小限のアンビエント宣言。
declare module "gifenc" {
  export type RGB = [number, number, number];
  export type RGBA = [number, number, number, number];

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: "rgb565" | "rgb444" | "rgba4444" },
  ): (RGB | RGBA)[];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: (RGB | RGBA)[],
    format?: "rgb565" | "rgb444" | "rgba4444",
  ): Uint8Array;

  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: (RGB | RGBA)[]; delay?: number; repeat?: number; transparent?: boolean },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;
}

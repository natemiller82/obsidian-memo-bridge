// Rasterising inside Obsidian (Chromium canvas). The eval harness uses eval/raster-node.ts.
import type { Rgba } from "./image";
import type { Raster } from "./inputs";

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("image load failed")); img.src = url; });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pixels(img: CanvasImageSource, w: number, h: number): Rgba {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { w, h, px: d.data };
}

export const domRaster: Raster = {
  async svgToRgba(svg: string, w: number, h: number): Promise<Rgba> {
    return pixels(await loadImage(new Blob([svg], { type: "image/svg+xml" })), w, h);
  },
  async jpegToRgba(bytes: Uint8Array): Promise<Rgba> {
    const img = await loadImage(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    return pixels(img, img.naturalWidth, img.naturalHeight);
  },
};

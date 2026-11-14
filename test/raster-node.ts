// Node rasterising for the eval harness and tests (the plugin uses the browser canvas instead).
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import type { Rgba } from "../src/recognize/image";
import type { Raster } from "../src/recognize/inputs";

export const nodeRaster: Raster = {
  async svgToRgba(svg: string, w: number): Promise<Rgba> {
    const r = new Resvg(svg, { fitTo: { mode: "width", value: w }, background: "#ffffff" }).render();
    return { w: r.width, h: r.height, px: r.pixels };
  },
  async jpegToRgba(bytes: Uint8Array): Promise<Rgba> {
    const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { w: d.width, h: d.height, px: d.data };
  },
};

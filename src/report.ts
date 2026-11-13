import type { DryRunReport } from "./sync";
import { localIso } from "./log";

export function formatDryRun(r: DryRunReport): string {
  const d = (ms: number | null) => (ms === null ? "—" : localIso(new Date(ms)).slice(0, 16).replace("T", " "));
  const kv = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join("\n") || "  (none)";
  const lines = [
    `Range: ${r.dateField} date from ${d(r.range.since)} to ${d(r.range.until)}`,
    `Samsung notes in total: ${r.totalNotes}; inside the range and filters: ${r.inRange}`,
    `Would import: ${r.toImport} notes, ${(r.bytes / 1e6).toFixed(1)} MB of attachments`,
    "",
    "By render:", kv(r.byRender),
    "By content:", kv(r.byContent),
    "By Samsung folder (import order: oldest folder first):", kv(r.byFolder),
    "",
    "Not imported, and why:", kv(r.skipped as Record<string, number>),
    "",
    `Thumbnail fallbacks (sdocx can't render; first page only): ${r.thumbnailFallbacks.length}`,
    ...r.thumbnailFallbacks.slice(0, 200).map((t) => `  ${t.created}  ${t.folder}  ${t.id}`),
    r.thumbnailFallbacks.length > 200 ? `  … ${r.thumbnailFallbacks.length - 200} more (full list in the saved report)` : "",
    `Text-only fallbacks (sdocx can't render, no thumbnail; typed text only): ${r.textOnlyFallbacks.length}`,
    ...r.textOnlyFallbacks.map((t) => `  ${t.created}  ${t.folder}  ${t.id}`),
    `Can't import at all: ${r.notRenderable.length}`,
    ...r.notRenderable.map((t) => `  ${t.folder}  ${t.id}  ${t.reason}`),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

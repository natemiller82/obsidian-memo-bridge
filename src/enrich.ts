// The enrich stage: optional, model-derived additions to imported notes. Rules:
//  * the original render embed and the image files are never modified (an opt-in may add alt
//    text to the embed of a note the user hasn't edited);
//  * sections go between <!-- memo-bridge:enrich:<name> begin ... --> and
//    <!-- memo-bridge:enrich:<name> end --> markers; a re-run replaces only that block;
//  * if the user edited the note, the output goes to a sidecar <name>.enrich-<enricher>.md;
//  * enrichers run from a queue outside the sync cycle (src/recognize/queue.ts), never inline.
// The one enricher is "transcribe" (src/recognize): text recognition and alt text.

/** Revision path columns hold one path (Python bridge) or a JSON list (plugin, one per page). */
export function pathList(v: string | null): string[] {
  if (!v) return [];
  return v.startsWith("[") ? (JSON.parse(v) as string[]) : [v];
}

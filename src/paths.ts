import * as path from "node:path";

/** Samsung Notes' Store package family name (identical on every Windows install). */
export const SAMSUNG_PACKAGE = "SAMSUNGELECTRONICSCoLtd.SamsungNotes_wyx1vj98g3asy";

function localAppData(): string {
  const v = process.env.LOCALAPPDATA;
  if (!v) throw new Error("LOCALAPPDATA is not set (Memo Bridge only supports Windows)");
  return v;
}

/** Where Samsung Notes keeps its data. Read-only for us. */
export function defaultLocalState(): string {
  return path.join(localAppData(), "Packages", SAMSUNG_PACKAGE, "LocalState");
}

/**
 * Memo Bridge's own data, outside the vault (so sync tools don't carry it to phones):
 * state.sqlite, .sdocx backups, model-input renders, snapshots, logs.
 * Shared with the Python reference implementation.
 */
export function defaultDataDir(): string {
  return process.env.MEMO_BRIDGE_HOME || path.join(localAppData(), "memo-bridge");
}

export class DataPaths {
  constructor(readonly root: string) {}
  get stateDb() { return path.join(this.root, "state.sqlite"); }
  get snapDir() { return path.join(this.root, "snap"); }
  get sdocxDir() { return path.join(this.root, "sdocx"); }
  get modelInputDir() { return path.join(this.root, "model-input"); }
  get logDir() { return path.join(this.root, "logs"); }
  get logFile() { return path.join(this.logDir, "plugin.log"); }
  get reportsDir() { return path.join(this.root, "reports"); }
  /** Python bridge files: held locked while it runs. */
  get pythonLocks() { return [path.join(this.root, "bridge.lock"), path.join(this.root, "cycle.lock")]; }
  get pythonConfig() { return path.join(this.root, "config.json"); }
}

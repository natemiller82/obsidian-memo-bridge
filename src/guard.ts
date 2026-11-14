import * as fs from "node:fs";

/**
 * Is the Python reference bridge running? It holds Windows byte-range locks on
 * bridge.lock (and cycle.lock during a sync); reading a locked byte fails.
 * No process is spawned for this check.
 */
export function pythonBridgeRunning(lockFiles: string[]): boolean {
  for (const f of lockFiles) {
    if (!fs.existsSync(f)) continue;
    let fd: number | null = null;
    try {
      fd = fs.openSync(f, "r");
      const size = fs.fstatSync(fd).size;
      if (size > 0) fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "EIO") return true;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }
  return false;
}

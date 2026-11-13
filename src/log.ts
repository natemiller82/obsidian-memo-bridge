import * as fs from "node:fs";
import * as path from "node:path";

export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

/** Appends to a file outside the vault; rotates at 1 MB, keeps 5 old files. */
export class FileLogger implements Logger {
  constructor(private file: string, private maxBytes = 1_000_000, private keep = 5, private echo = false,
              public minLevel: Level = "INFO") {}

  private write(level: Level, msg: string) {
    const order: Level[] = ["DEBUG", "INFO", "WARN", "ERROR"];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) return;
    const line = `${localIso(new Date())} ${level.padEnd(5)} ${msg}\n`;
    if (this.echo) (level === "ERROR" ? console.error : console.log)(`[memo-bridge] ${line.trimEnd()}`);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.rotate();
      fs.appendFileSync(this.file, line, "utf8");
    } catch (e) {
      console.error("[memo-bridge] log write failed", e);
    }
  }

  private rotate() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.maxBytes) return;
    for (let i = this.keep - 1; i >= 1; i--) {
      const a = `${this.file}.${i}`, b = `${this.file}.${i + 1}`;
      if (fs.existsSync(a)) fs.renameSync(a, b);
    }
    fs.renameSync(this.file, `${this.file}.1`);
  }

  debug(m: string) { this.write("DEBUG", m); }
  info(m: string) { this.write("INFO", m); }
  warn(m: string) { this.write("WARN", m); }
  error(m: string, err?: unknown) {
    const detail = err instanceof Error ? `: ${err.message}${err.stack ? `\n${err.stack}` : ""}` : err ? `: ${String(err)}` : "";
    this.write("ERROR", m + detail);
  }
}

export class MemoryLogger implements Logger {
  lines: string[] = [];
  debug(m: string) { this.lines.push(`DEBUG ${m}`); }
  info(m: string) { this.lines.push(`INFO ${m}`); }
  warn(m: string) { this.lines.push(`WARN ${m}`); }
  error(m: string, err?: unknown) { this.lines.push(`ERROR ${m}${err ? `: ${err instanceof Error ? err.message : err}` : ""}`); }
}

export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

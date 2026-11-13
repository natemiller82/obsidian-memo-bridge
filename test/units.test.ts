import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { escapeMarkdown, textToMarkdown } from "../src/text";
import { baseName, sanitizeName, upsertSection } from "../src/writer";
import { correctionFor, NO_CORRECTION, type PenStroke } from "../src/render/pens";
import { zipStored, crc32 } from "../src/zip";
import { pythonBridgeRunning } from "../src/guard";
import { folderAllowed } from "../src/sync";
import { parseSince, parseUntil } from "../src/config";
import type { SourceNote } from "../src/source";

describe("text -> markdown", () => {
  it("drops Samsung's positioning blank lines and records them", () => {
    const r = textToMarkdown({ text: "\n\n\nTest in txt\n", spans: [] })!;
    expect(r).toEqual({ markdown: "Test in txt", leadingBlankLines: 3 });
  });
  it("bold / underline / highlight spans", () => {
    const text = "plain bold under mark";
    const r = textToMarkdown({ text, spans: [
      { kind: "Bold", start: 6, end: 10, payload: [1, 0, 0, 0] },
      { kind: "Underline", start: 11, end: 16, payload: [1, 0, 0, 0] },
      { kind: "BackgroundColor", start: 17, end: 21, payload: [255, 240, 0, 255] },
      { kind: "FontSize", start: 0, end: 21, payload: [0, 0, 136, 65] },
    ] })!;
    expect(r.markdown).toBe("plain **bold** <u>under</u> ==mark==");
  });
  it("escapes Markdown/Obsidian syntax in typed text", () => {
    expect(escapeMarkdown("# not a heading")).toBe("\\# not a heading");
    expect(escapeMarkdown("a *b* [[c]] #tag $x$ %%c%%")).toBe("a \\*b\\* \\[\\[c\\]\\] \\#tag \\$x\\$ \\%\\%c\\%\\%");
    expect(escapeMarkdown("- item")).toBe("\\- item");
  });
});

describe("names", () => {
  it("sanitises titles for files", () => {
    expect(sanitizeName('a/b:c*?"<>|#^[x]  ')).toBe("a b c x");
    expect(sanitizeName("CON")).toBe("_CON");
    expect(sanitizeName(".hidden.")).toBe("hidden");
  });
  it("title, then title (short id), then date-id; collisions lengthen", () => {
    const id = "f1f1f1f1-0000-4000-0000-0123456789ab";
    expect(baseName("2024-01-02", id, "Shopping", new Set())).toBe("Shopping");
    expect(baseName("2024-01-02", id, "Shopping", new Set(["shopping"]))).toBe("Shopping (456789ab)");
    expect(baseName("2024-01-02", id, "", new Set())).toBe("2024-01-02-456789ab");
    expect(baseName("2024-01-02", `${id}_screenoff`, "", new Set(["2024-01-02-456789ab"]))).toBe("2024-01-02-0123456789ab");
  });
  it("enrich sections are replaced in place", () => {
    const a = upsertSection("note\n", "ocr", "one", "v=1");
    const b = upsertSection(a, "ocr", "two", "v=2");
    expect(b).toContain("two");
    expect(b).not.toContain("one");
    expect(b.match(/begin/g)?.length).toBe(1);
  });
});

describe("pen table", () => {
  const st = (pen: string, settings: string, o: Partial<PenStroke> = {}): PenStroke =>
    ({ pen, settings, alpha: 1, width: 10, drawn: "lines", ...o });
  it("is data-driven: pen type + how sdocx drew it -> width/opacity", () => {
    // held, provisional: only the line-drawn 13; fountain pen is scaled
    expect(correctionFor(st("FountainPen", "13;"), 2.6)).toEqual({ scale: 2.6, opacity: 1 });
    for (const s of ["11;", "12;", "15;0;100;"]) expect(correctionFor(st("FountainPen", s), 2.6)).toEqual(NO_CORRECTION);
    expect(correctionFor(st("FountainPen", "14;", { drawn: "outline" }), 2.6)).toEqual(NO_CORRECTION);
    expect(correctionFor(st("FountainPen", "18;0;100;", { drawn: "stamps" }), 2.6)).toEqual(NO_CORRECTION);
    // constant widths relative to the stroke's own pen size, any settings string
    expect(correctionFor(st("InkPen2", "9;", { width: 6 }), 2.6)).toEqual({ scale: 1, constant: 6.18, opacity: 1 });
    expect(correctionFor(st("InkPen2", "99;", { width: 6 }), 2.6).constant).toBeCloseTo(6.18);
    const m = correctionFor(st("Marker3", "5;", { alpha: 115 / 255, width: 20 }), 2.6);
    expect(m.constant).toBeCloseTo(19.6); expect(m.opacity).toBeCloseTo(0.451, 2);
    const p = correctionFor(st("Pencil2", "14;", { width: 10 }), 2.6);
    expect(p.constant).toBeCloseTo(7.3); expect(p.opacity).toBeCloseTo(0.29);
    expect(correctionFor(st("Pencil2", "14;", { alpha: 0.5 }), 2.6).opacity).toBeCloseTo(0.145);
    expect(correctionFor(st("ObliquePen", "4;"), 2.6)).toEqual({ scale: 3.6, opacity: 1 });
    expect(correctionFor(st("BrushPen", "10;"), 2.6)).toEqual(NO_CORRECTION);
    expect(correctionFor(st("Marker4", "8;", { alpha: 0.45 }), 2.6)).toEqual(NO_CORRECTION);
    // a pen sdocx starts drawing natively is no longer corrected
    expect(correctionFor(st("InkPen2", "9;", { drawn: "stamps" }), 2.6)).toEqual(NO_CORRECTION);
    expect(correctionFor(st("X", ""), 2.6, [{ pen: "X", scale: 2 }])).toEqual({ scale: 2, opacity: 1 });
  });
});

describe("zip", () => {
  it("writes a valid stored zip (checked with PowerShell's .NET zip reader)", () => {
    const z = zipStored([{ name: "b/x.txt", data: new TextEncoder().encode("hello") }, { name: "a.bin", data: new Uint8Array([1, 2, 3]) }]);
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    const f = path.join(os.tmpdir(), `mb-${process.pid}.zip`);
    fs.writeFileSync(f, z);
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        `Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${f}').Entries | % { $_.FullName + ':' + $_.Length }`], { encoding: "utf8" });
      expect(out.trim().split(/\r?\n/)).toEqual(["a.bin:3", "b/x.txt:5"]);
    } finally { fs.rmSync(f); }
  });
});

describe("folder filters and dates", () => {
  const n = (folder: string[]) => ({ folder } as SourceNote);
  it("matches folders and subfolders, case-insensitively", () => {
    expect(folderAllowed(n(["Work", "Meetings"]), ["work"], [])).toBe(true);
    expect(folderAllowed(n(["Workshop"]), ["work"], [])).toBe(false);
    expect(folderAllowed(n(["Work", "Meetings"]), [], ["Work/Meetings"])).toBe(false);
    expect(folderAllowed(n([]), [], ["Work"])).toBe(true);
  });
  it("date bounds: since = start of day, until = end of day (local)", () => {
    expect(parseSince("2024-03-05")).toBe(new Date(2024, 2, 5).getTime());
    expect(parseUntil("2024-03-05")).toBe(new Date(2024, 2, 6).getTime() - 1);
    expect(parseSince("")).toBeNull();
    expect(() => parseSince("soon")).toThrow();
  });
});

describe("Python bridge guard", () => {
  const py = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".venv", "Scripts", "python.exe");
  it.skipIf(!fs.existsSync(py))("detects the msvcrt lock the Python bridge holds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mb-lock-"));
    const lock = path.join(dir, "bridge.lock");
    fs.writeFileSync(lock, "12345");
    expect(pythonBridgeRunning([lock])).toBe(false);
    const child = spawn(py, ["-I", "-c",
      `import msvcrt,sys,time\nf=open(r'${lock}','r+b')\nmsvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)\nprint('locked',flush=True)\nsys.stdin.read()`]);
    await new Promise<void>((res) => child.stdout.on("data", () => res()));
    try {
      expect(pythonBridgeRunning([lock])).toBe(true);
    } finally {
      child.stdin.end();          // the venv python.exe is a launcher; let the real interpreter exit itself
    }
    await new Promise((r) => child.on("exit", r));
    expect(pythonBridgeRunning([lock])).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("eval metrics", async () => {
  const { agree, cer, cleanOcr, lev, norm, wer } = await import("../eval/metrics");
  it("edit distance, CER/WER, agreement", () => {
    expect(lev([..."kitten"], [..."sitting"])).toBe(3);
    expect(cer("buy milk", "buy milk")).toBe(0);
    expect(cer("buy mlk", "buy milk")).toBeCloseTo(1 / 8);
    expect(wer("buy the milk", "buy milk")).toBeCloseTo(1 / 2);
    expect(cer("Buy milk!", "buy milk", true)).toBe(0);              // loose: case and punctuation ignored
    expect(norm("call [?]  tomorrow")).toBe("call tomorrow");
    expect(cer("", "")).toBe(0);
    expect(cer("invented", "")).toBe(1);                             // text on an empty page is an error
    expect(agree("A b", "a B.")).toBe(1);
  });
  it("OCR-only answers: fences stripped, no letters or digits means no text", () => {
    expect(cleanOcr("```markdown\n\n```")).toBe("");
    expect(cleanOcr("→")).toBe("");
    expect(cleanOcr("```markdown\r\nbuy milk\r\n2 eggs\r\n```")).toBe("buy milk\n2 eggs");
    expect(cleanOcr("plain text")).toBe("plain text");
  });
});

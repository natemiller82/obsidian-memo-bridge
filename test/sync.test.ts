import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADOPTED_HASH, State } from "../src/state";
import { SnapshotError } from "../src/source";
import { ageTree, defaultRows, Env, FAKE_ACCOUNT_KEY, FIX, frontmatter, ID, T0 } from "./helpers";
import { SyncEngine, type EngineDeps } from "../src/sync";
import { PEN_TABLE_VERSION } from "../src/render/pens";
import { sha256 } from "../src/writer";

let env: Env | null = null;
const make = (opts?: ConstructorParameters<typeof Env>[0]) => (env = new Env(opts));
afterEach(() => { env?.dispose(); env = null; });

const NEW_NOTES = [ID.mixed, ID.scribble2p, ID.pencil, ID.pens, ID.pens2, ID.suffix, ID.legacy];

describe("which notes", () => {
  it("imports all current-format notes by default; skips sdoc duplicates, trashed and locked", async () => {
    const e = make();
    const rep = await e.engine.poll();
    expect(rep.errors).toEqual([]);
    expect(rep.written.length).toBe(NEW_NOTES.length);
    for (const id of NEW_NOTES) expect(e.state.get(id), id).not.toBeNull();
    for (const id of [ID.sdoc, ID.trashed, ID.locked]) expect(e.state.get(id), id).toBeNull();
    expect(rep.skipped).toMatchObject({ "legacy-duplicate": 1, trashed: 1, locked: 1 });
    expect(e.log.lines.some((l) => l.includes(`skipping locked note ${ID.locked}`))).toBe(true);
  });

  it("screen-off-only matches the folder or the _screenoff id suffix", async () => {
    const e = make({ cfg: { screenOffOnly: true } });
    const rep = await e.engine.poll();
    expect(new Set(rep.written.map((p) => frontmatter(e.read(p)).samsung_note_id))).toEqual(new Set([ID.pencil, ID.suffix]));
    for (const p of rep.written) expect(frontmatter(e.read(p)).source).toBe("screen-off-memo");
  });

  it("include/exclude folders (subfolders included)", async () => {
    let e = make({ cfg: { includeFolders: ["Work"] } });
    expect((await e.engine.poll()).written.map((p) => frontmatter(e.read(p)).samsung_note_id)).toEqual([ID.pens]);
    e.dispose();
    e = make({ cfg: { excludeFolders: ["work", "To Do", "Screen off memo"] } });
    const ids = (await e.engine.poll()).written.map((p) => frontmatter(e.read(p)).samsung_note_id).sort();
    expect(ids).toEqual([ID.mixed, ID.pens2, ID.suffix, ID.legacy].sort());
  });
});

describe("output", () => {
  it("mirrors Samsung folders, writes frontmatter, keeps backups outside the vault", async () => {
    const e = make();
    await e.engine.poll();
    const files = await e.mdFiles();
    expect(files).toContain("Samsung Notes/Work/Meetings/Pen test.md");             // real title
    expect(files.some((f) => f.startsWith("Samsung Notes/Screen off memo/"))).toBe(true);  // zero-width char stripped
    expect(files.some((f) => f.startsWith("Samsung Notes/To Do/"))).toBe(true);
    expect(files.some((f) => /^Samsung Notes\/Uncategorized\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.md$/.test(f))).toBe(true);

    const fm = frontmatter(e.read("Samsung Notes/Work/Meetings/Pen test.md"));
    expect(fm).toMatchObject({ samsung_note_id: ID.pens, folder: "Work/Meetings", source: "samsung-note", content: "handwriting",
      revision: "1", render: "sdocx", ink_scale: "2.6", pen_table: String(PEN_TABLE_VERSION) });
    expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const sdocx = fm.sdocx_backup.replace("%LOCALAPPDATA%", process.env.LOCALAPPDATA ?? "");
    expect(fs.existsSync(path.isAbsolute(sdocx) ? sdocx : path.join(e.data.sdocxDir, path.basename(sdocx)))).toBe(true);

    const all: string[] = [];
    const walk = (d: string) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) x.isDirectory() ? walk(path.join(d, x.name)) : all.push(x.name); };
    walk(e.vaultDir);
    expect(all.filter((f) => !/\.(md|svg|jpg)$/.test(f))).toEqual([]);              // no .sdocx/.png/raw in the vault
    expect(fs.readdirSync(e.data.sdocxDir).length).toBe(NEW_NOTES.length);
    expect(fs.readdirSync(e.data.modelInputDir).some((f) => f.endsWith(".raw.svg"))).toBe(true);
  });

  it("mixed note: typed text as Markdown after the ink, not drawn into the SVG", async () => {
    const e = make();
    await e.engine.poll();
    const md = e.read(e.state.get(ID.mixed)!.md_path);
    expect(frontmatter(md).content).toBe("mixed");
    const body = md.split("\n---\n")[1];
    expect(body.indexOf("![[")).toBeLessThan(body.indexOf("Test in txt"));
    const svg = e.read(e.state.latestRevision(ID.mixed)!.attachment_path);
    expect(svg).not.toContain("<text");
  });

  it("multi-page notes get one SVG per non-blank page", async () => {
    const e = make();
    await e.engine.poll();
    const md2 = e.read(e.state.get(ID.scribble2p)!.md_path);
    expect(md2.match(/!\[\[[^\]]+\.p\d\.svg\]\]/g)?.length).toBe(2);
    expect(frontmatter(md2).pages).toBe("2");
    const mdBlank = e.read(e.state.get(ID.pens2)!.md_path);   // page 2 is blank -> single SVG
    expect(mdBlank.match(/!\[\[/g)?.length).toBe(1);
  });

  it("notes sdocx can't parse fall back to the thumbnail + typed text, marked render: thumbnail", async () => {
    const e = make();
    await e.engine.poll();
    const md = e.read(e.state.get(ID.legacy)!.md_path);
    const fm = frontmatter(md);
    expect(fm.render).toBe("thumbnail");
    expect(fm.render_note).toMatch(/could not render/);
    expect(md).toMatch(/!\[\[[^\]]+\.jpg\]\]/);
    expect(md).toContain("old typed text");
    expect(fs.existsSync(path.join(e.data.sdocxDir, `${ID.legacy}.r1.sdocx`))).toBe(true);   // re-renderable later
  });

  it("styled SVGs are cropped and smaller than the raw render", async () => {
    const e = make();
    await e.engine.poll();
    const rev = e.state.latestRevision(ID.pens2)!;
    const svg = e.read(rev.attachment_path);
    const raw = fs.readFileSync(JSON.parse(rev.raw_svg_path!)[0], "utf8");
    // pressure-varying pens limit merging; ballpoint-style memos shrink to ~15-25%
    expect(svg.length).toBeLessThan(raw.length * 0.6);
    expect(svg).toMatch(/<rect [^>]*rx="28"/);
    expect(svg).not.toContain("data-mb-");
  });
});

describe("idempotence and change detection", () => {
  it("a second poll writes nothing; an idle poll doesn't even snapshot", async () => {
    const e = make();
    await e.engine.poll();
    const before = await e.mdFiles();
    const again = await e.engine.poll(true);
    expect(again.written).toEqual([]);
    expect(await e.mdFiles()).toEqual(before);
    let listed = 0;
    const orig = e.source.listNotes.bind(e.source);
    e.source.listNotes = async () => { listed++; return orig(); };
    expect((await e.engine.poll()).snapshot).toBe(false);
    expect(listed).toBe(0);
  });

  it("after a restart, catches up on notes that arrived while closed (cursor = state, not 'now')", async () => {
    const e = make({ rows: defaultRows().filter((r) => r.UUID !== ID.pens2) });
    await e.engine.poll();
    // "Obsidian closed": a note arrives in Samsung; then a brand-new engine starts on the same state.
    fs.cpSync(path.join(FIX, "notes", ID.pens2), e.noteFolder(ID.pens2), { recursive: true });
    ageTree(e.noteFolder(ID.pens2));
    const db = new (await import("node:sqlite")).DatabaseSync(path.join(e.localState, "Storage.sqlite"));
    db.close();
    e.insertRow({ ...defaultRows().find((r) => r.UUID === ID.pens2)! });
    const restarted = new SyncEngine((e.engine as unknown as { deps: EngineDeps }).deps, e.engine.cfg);
    const rep = await restarted.poll();
    expect(rep.written.map((p) => frontmatter(e.read(p)).samsung_note_id)).toEqual([ID.pens2]);
  });
});

describe("settle guard", () => {
  it("waits for end_tag.bin and for the folder to stop changing", async () => {
    const e = make();
    const dir = e.noteFolder(ID.pens);
    fs.renameSync(path.join(dir, "end_tag.bin"), path.join(dir, "end_tag.tmp"));
    let rep = await e.engine.poll();
    expect(rep.pending).toContain(ID.pens);
    expect(e.state.get(ID.pens)).toBeNull();
    fs.renameSync(path.join(dir, "end_tag.tmp"), path.join(dir, "end_tag.bin"));   // fresh mtime -> settling
    rep = await e.engine.poll();
    expect(rep.pending).toContain(ID.pens);
    ageTree(dir);
    rep = await e.engine.poll();
    expect(rep.pending).toEqual([]);
    expect(e.state.get(ID.pens)).not.toBeNull();
  });
});

describe("updates never overwrite the user's edits", () => {
  it("unedited note is updated in place; edited note gets .r2.md and stays byte-identical", async () => {
    const e = make();
    await e.engine.poll();
    const p = e.state.get(ID.pens)!.md_path;
    e.samsungEdit(ID.pens);
    expect((await e.engine.poll()).written).toEqual([p]);
    expect(frontmatter(e.read(p)).revision).toBe("2");

    const edited = e.read(p) + "\nmy own notes\n";
    fs.writeFileSync(path.join(e.vaultDir, ...p.split("/")), edited);
    e.samsungEdit(ID.pens);
    const rep = await e.engine.poll();
    expect(rep.written).toEqual(["Samsung Notes/Work/Meetings/Pen test.r3.md"]);
    expect(e.read(p)).toBe(edited);
    const fm = frontmatter(e.read(rep.written[0]));
    expect(fm.previous_revision).toBe("[[Pen test]]");
    expect(fm.revision).toBe("3");
  });

  it("re-render: notes on an older pen table are redrawn in place if unedited, as a new revision if edited", async () => {
    const e = make();
    await e.engine.poll();
    expect(await e.engine.rerenderCandidates()).toEqual([]);
    // Simulate notes written by an older version: pen_table 1 in the frontmatter.
    const age = (id: string, extra = "") => {
      const p = e.state.get(id)!.md_path;
      const md = e.read(p).replace(/^pen_table: \d+$/m, "pen_table: 1") + extra;
      fs.writeFileSync(path.join(e.vaultDir, ...p.split("/")), md);
      if (!extra) e.state.updateMdHash(id, sha256(md));          // as if we wrote it: unedited
      return { p, md };
    };
    const clean = age(ID.pens), edited = age(ID.pens2, "\nmy own notes\n");
    const cands = await e.engine.rerenderCandidates();
    expect(cands.map((c) => c.id).sort()).toEqual([ID.pens, ID.pens2].sort());
    expect(cands.every((c) => c.penTable === 1)).toBe(true);

    const r = await e.engine.rerender([ID.pens, ID.pens2, "f1f1f1f1-0000-4000-0000-00000000dead"]);
    expect(r.failed).toEqual([{ id: "f1f1f1f1-0000-4000-0000-00000000dead", reason: "not imported by Memo Bridge" }]);
    // unedited: same file, new revision, current pen table
    expect(r.written).toContain(clean.p);
    const fm = frontmatter(e.read(clean.p));
    expect(fm.pen_table).toBe(String(PEN_TABLE_VERSION));
    expect(fm.revision).toBe("2");
    expect(e.state.latestRevision(ID.pens)!.reason).toBe("re-render");
    // edited: left byte-identical; a new revision file next to it
    expect(e.read(edited.p)).toBe(edited.md);
    const r2 = r.written.find((p) => p !== clean.p)!;
    expect(r2).toMatch(/\.r2\.md$/);
    expect(frontmatter(e.read(r2)).pen_table).toBe(String(PEN_TABLE_VERSION));
    expect(e.state.latestRevision(ID.pens2)!.reason).toBe("re-render-user-edited");
    expect(await e.engine.rerenderCandidates()).toEqual([]);
    // Samsung unchanged, so the next poll writes nothing
    expect((await e.engine.poll(true)).written).toEqual([]);
  });

  it("a moved/deleted note also gets a new revision instead of being recreated in place", async () => {
    const e = make();
    await e.engine.poll();
    const p = e.state.get(ID.pens2)!.md_path;
    fs.renameSync(path.join(e.vaultDir, ...p.split("/")), path.join(e.vaultDir, "moved.md"));
    e.samsungEdit(ID.pens2);
    const rep = await e.engine.poll();
    expect(rep.written[0]).toMatch(/\.r2\.md$/);
    expect(fs.existsSync(path.join(e.vaultDir, ...p.split("/")))).toBe(false);
  });

  it("deletions in Samsung are only logged", async () => {
    const e = make();
    await e.engine.poll();
    const db = new (await import("node:sqlite")).DatabaseSync(path.join(e.localState, "Storage.sqlite"));
    db.prepare("UPDATE NoteDB SET DeletedStatus=2 WHERE UUID=?").run(ID.mixed);
    db.close();
    e.engine.invalidate();
    await e.engine.poll();
    expect(fs.existsSync(path.join(e.vaultDir, ...e.state.get(ID.mixed)!.md_path.split("/")))).toBe(true);
    expect(e.log.lines.some((l) => l.includes(`note ${ID.mixed} is in Samsung's trash`))).toBe(true);
  });
});

describe("date range", () => {
  it("since is inclusive on the created date", async () => {
    const e = make({ cfg: { sinceMs: T0 + 4000 } });
    const ids = (await e.engine.poll()).written.map((p) => frontmatter(e.read(p)).samsung_note_id).sort();
    expect(ids).toEqual([ID.pens, ID.pens2, ID.suffix].sort());
  });

  it("until bounds the range; modified-date filtering picks up old notes edited recently", async () => {
    let e = make({ cfg: { sinceMs: T0 + 2000, untilMs: T0 + 3000 } });
    expect((await e.engine.poll()).written.length).toBe(2);
    e.dispose();
    e = make({ cfg: { sinceMs: T0 + 10_000, dateField: "modified" } });
    expect((await e.engine.poll()).written).toEqual([]);
    e.samsungEdit(ID.legacy);                                                       // old note, edited "now"
    const db = new (await import("node:sqlite")).DatabaseSync(path.join(e.localState, "Storage.sqlite"));
    db.prepare("UPDATE NoteDB SET LastModifiedAt=? WHERE UUID=?").run(T0 + 20_000, ID.legacy);
    db.close();
    e.engine.invalidate();
    expect((await e.engine.poll()).written.map((p) => frontmatter(e.read(p)).samsung_note_id)).toEqual([ID.legacy]);
  });

  it("narrowing the range later never removes imported notes, and they keep updating", async () => {
    const e = make();
    await e.engine.poll();
    const files = await e.mdFiles();
    e.engine.cfg = { ...e.engine.cfg, sinceMs: T0 + 1e9 };
    e.samsungEdit(ID.pens);
    const rep = await e.engine.poll();
    expect(rep.written).toEqual([e.state.get(ID.pens)!.md_path]);
    expect(await e.mdFiles()).toEqual(files);
  });
});

describe("snapshot", () => {
  it("retries a locked/failed copy and then succeeds", async () => {
    let fails = 2;
    const e = make({ copyFile: (s, d) => { if (s.endsWith("Storage.sqlite") && fails-- > 0) throw Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" }); fs.copyFileSync(s, d); } });
    const rep = await e.engine.poll();
    expect(rep.errors).toEqual([]);
    expect(rep.written.length).toBe(NEW_NOTES.length);
    expect(e.log.lines.filter((l) => l.includes("snapshot attempt")).length).toBe(2);
  });

  it("gives up after repeated failures: reports, writes nothing, retries next poll", async () => {
    const e = make({ copyFile: () => { throw new Error("EBUSY: locked"); } });
    const rep = await e.engine.poll();
    expect(rep.errors[0]?.kind).toBe("snapshot");
    expect(rep.written).toEqual([]);
    expect(await e.mdFiles()).toEqual([]);
  });

  it("reads rows that are still only in the -wal file (never the stale main file)", async () => {
    const e = make({ wal: true });
    expect(fs.statSync(path.join(e.localState, "Storage.sqlite-wal")).size).toBeGreaterThan(0);
    const rep = await e.engine.poll();
    expect(rep.written.length).toBe(NEW_NOTES.length);
    const snap = path.join(e.data.snapDir, "Storage.sqlite-wal");
    expect(fs.existsSync(snap) || fs.existsSync(path.join(e.data.snapDir, "Storage.sqlite"))).toBe(true);
  });

  it("detects a database that changes while being copied", async () => {
    let n = 0;
    const e = make({
      copyFile: (s, d) => {
        fs.copyFileSync(s, d);
        if (s.endsWith("Storage.sqlite") && n++ < 1) fs.utimesSync(s, new Date(), new Date(Date.now() + 5000));
      },
    });
    const rep = await e.engine.poll();
    expect(rep.errors).toEqual([]);
    expect(e.log.lines.some((l) => l.includes("changed while copying"))).toBe(true);
  });

  it("SnapshotError when Storage.sqlite is gone", async () => {
    const e = make();
    fs.rmSync(path.join(e.localState, "Storage.sqlite"));
    expect(e.source.unavailable()).toMatch(/not found/);
    await expect(e.source.snapshot()).rejects.toBeInstanceOf(SnapshotError);
  });
});

describe("dedupe against the vault and the Python bridge's state", () => {
  it("doesn't rewrite a note already in the vault (any folder); records it as not ours", async () => {
    const e = make();
    const existing = `---\ncreated: x\nsamsung_note_id: ${ID.pens}\n---\n\n![[old.svg]]\n`;
    fs.mkdirSync(path.join(e.vaultDir, "Inbox", "Screen Off Memos"), { recursive: true });
    fs.writeFileSync(path.join(e.vaultDir, "Inbox", "Screen Off Memos", "old.md"), existing);
    await e.index.build(e.vault);
    const rep = await e.engine.poll();
    expect(rep.written.some((p) => p.includes("Pen test"))).toBe(false);
    expect(e.state.get(ID.pens)!.md_sha256).toBe(ADOPTED_HASH);
    e.samsungEdit(ID.pens);
    const upd = await e.engine.poll();
    expect(upd.written).toEqual(["Inbox/Screen Off Memos/old.r2.md"]);
    expect(e.read("Inbox/Screen Off Memos/old.md")).toBe(existing);
  });

  it("notes in the Python bridge's state.sqlite are known (same file and schema)", async () => {
    const e = make();
    e.state.close();
    const py = new State(e.data.stateDb);
    py.recordRevision({ note_id: ID.pencil, created_ms: T0 + 3000, samsung_modified_ms: T0 + 3000, revision: 1, name: "2026-01-01-0000f003",
      md_path: "Inbox/Screen Off Memos/2026-01-01-0000f003.md", md_sha256: "x", render: "sdocx-cli", deleted: 0 },
    { note_id: ID.pencil, revision: 1, name: "2026-01-01-0000f003", md_path: "Inbox/Screen Off Memos/2026-01-01-0000f003.md",
      attachment_path: "Inbox/Screen Off Memos/attachments/2026-01-01-0000f003.svg", sdocx_path: "x.sdocx", png_path: "x.png",
      raw_svg_path: "x.raw.svg", render: "sdocx-cli", samsung_modified_ms: T0 + 3000, reason: "new", written_at: "x" });
    py.close();
    e.state = new State(e.data.stateDb);
    (e.engine as unknown as { deps: { state: State } }).deps.state = e.state;
    const rep = await e.engine.poll();
    expect(rep.written.length).toBe(NEW_NOTES.length - 1);
    expect(rep.skipped.unchanged).toBe(1);
  });
});

describe("backfill", () => {
  it("dry run counts without writing; batches go oldest folder first", async () => {
    const e = make({ cfg: { sinceMs: T0 + 1e12 } });           // ongoing sync wants nothing
    expect((await e.engine.poll()).written).toEqual([]);
    const dry = await e.engine.dryRun({ since: null, until: null });
    expect(dry.toImport).toBe(NEW_NOTES.length);
    expect(dry.byRender).toMatchObject({ sdocx: 6, thumbnail: 1 });
    expect(dry.thumbnailFallbacks.map((t) => t.id)).toEqual([ID.legacy]);
    expect(dry.skipped).toMatchObject({ "legacy-duplicate": 1, trashed: 1, locked: 1 });
    expect(await e.mdFiles()).toEqual([]);

    const b1 = await e.engine.backfillBatch({ since: null, until: null }, 2);
    expect(b1.written.length).toBe(2);
    expect(b1.remaining).toBe(NEW_NOTES.length - 2);
    // Oldest folder first: Uncategorized holds the oldest note (the legacy one).
    expect(b1.written.every((p) => p.startsWith("Samsung Notes/Uncategorized/"))).toBe(true);
    const b2 = await e.engine.backfillBatch({ since: null, until: null }, 100);
    expect(b2.remaining).toBe(0);
    expect((await e.mdFiles()).length).toBe(NEW_NOTES.length);
  });
});

describe("lock detection (real LockAccountGuid distribution)", () => {
  it("only IsLocked marks a note locked; an account key in LockAccountGuid does not", async () => {
    const rows = defaultRows();
    // The fixture must look like a real library: the key on most current-format notes, empty on converted ones.
    const current = rows.filter((r) => r.DocumentType === 0);
    expect(current.filter((r) => r.LockAccountGuid === FAKE_ACCOUNT_KEY).length).toBeGreaterThan(current.length / 2);
    expect(current.some((r) => r.LockAccountGuid === "")).toBe(true);
    const e = make({ rows });
    const notes = await e.source.listNotes();
    expect(notes.filter((n) => n.locked).map((n) => n.id)).toEqual(rows.filter((r) => r.IsLocked).map((r) => r.UUID));
    const dry = await e.engine.dryRun({ since: null, until: null });
    expect(dry.skipped.locked).toBe(1);
    expect(dry.toImport).toBe(NEW_NOTES.length);
  });
});

describe("edge cases found on a real library", () => {
  it("styles a page with more points than Math.min(...) can take as arguments", async () => {
    const { styleSvg } = await import("../src/render/style");
    const n = 150_000;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = 100 + (i % 800), y = 100 + Math.floor(i / 800);
      lines.push(`<line stroke="#fbe156" stroke-linecap="round" stroke-width="1.2" x1="${x}" y1="${y}" x2="${x + 0.5}" y2="${y + 0.5}"/>`);
    }
    const raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 3054" width="1080" height="3054"><rect fill="#010101" width="1080" height="3054" x="0" y="0"/>${lines.join("")}</svg>`;
    const t0 = Date.now();
    const out = styleSvg(raw, [], { inkScale: 2.6, padding: 48, radius: 28, stripText: false });
    expect(Date.now() - t0).toBeLessThan(20_000);              // was quadratic: ~80 s before setChildren()
    expect(out).not.toBeNull();
    expect(out!.svg).toMatch(/viewBox="5[0-9.]+ 5[0-9.]+ /);   // cropped to the ink, not the full page
  });

  it("an unrenderable note without a thumbnail is imported as text, labelled render: text", async () => {
    const e = make();
    fs.rmSync(path.join(e.localState, "Thumbnail", `${ID.legacy}.jpg`));
    const dry = await e.engine.dryRun({ since: null, until: null });
    expect(dry.textOnlyFallbacks.map((t) => t.id)).toEqual([ID.legacy]);
    expect(dry.thumbnailFallbacks).toEqual([]);
    expect(dry.notRenderable).toEqual([]);
    await e.engine.poll();
    const md = e.read(e.state.get(ID.legacy)!.md_path);
    const fm = frontmatter(md);
    expect(fm.render).toBe("text");
    expect(fm.content).toBe("text");
    expect(fm.render_note).toMatch(/no thumbnail/);
    expect(md).not.toMatch(/!\[\[/);
    expect(md).toContain("old typed text");
  });
});

describe("page templates", () => {
  it("a page's background template image (e.g. Action memo paper) is not attached; a real image is", async () => {
    const e = make();
    const media = path.join(e.noteFolder(ID.pens), "media");
    fs.writeFileSync(path.join(media, "0@image0.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));   // template paper
    fs.writeFileSync(path.join(media, "1@photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));     // user's image
    ageTree(e.noteFolder(ID.pens));
    const deps = (e.engine as unknown as { deps: EngineDeps }).deps;
    const inner = deps.renderer;
    deps.renderer = { ...inner, warmUp: () => inner.warmUp(), dispose: () => inner.dispose(),
      render: async (b, t) => ({ ...(await inner.render(b, t)), backgroundMedia: ["0@image0.jpg"] }) };
    await e.engine.poll();
    const md = e.read(e.state.get(ID.pens)!.md_path);
    expect(md).toContain("1@photo.png]]");
    expect(md).not.toContain("0@image0.jpg");
  });
});

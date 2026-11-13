import * as fs from "node:fs";
import * as path from "node:path";
import { App, Modal, Notice, Setting } from "obsidian";
import type MemoBridgePlugin from "./main";
import { parseSince, parseUntil } from "./config";
import type { DryRunReport, SyncEngine } from "./sync";
import { formatDryRun } from "./report";

export { formatDryRun };
import { localIso } from "./log";

export class LogModal extends Modal {
  constructor(app: App, private file: string) { super(app); }
  onOpen() {
    this.titleEl.setText("Memo Bridge log");
    let text = "(no log yet)";
    try {
      const lines = fs.readFileSync(this.file, "utf8").trimEnd().split("\n");
      text = lines.slice(-300).join("\n");
    } catch { /* missing */ }
    new Setting(this.contentEl).setName("Log file").setDesc(this.file)
      .addButton((b) => b.setButtonText("Copy path").onClick(async () => {
        await navigator.clipboard.writeText(this.file); new Notice("Copied");
      }));
    const pre = this.contentEl.createEl("pre", { cls: "memo-bridge-report", text });
    window.setTimeout(() => { pre.scrollTop = pre.scrollHeight; }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

export class BackfillModal extends Modal {
  private since: string;
  private until: string;
  private report: DryRunReport | null = null;
  private out!: HTMLElement;
  private batchBtn: HTMLButtonElement | null = null;

  constructor(app: App, private plugin: MemoBridgePlugin, private engine: SyncEngine,
              private exclusive: <T>(fn: () => Promise<T>) => Promise<T>) {
    super(app);
    this.since = "";
    this.until = plugin.settings.until;
  }

  private range() { return { since: parseSince(this.since), until: parseUntil(this.until) }; }

  onOpen() {
    const c = this.contentEl;
    this.titleEl.setText("Backfill older Samsung notes");
    c.createEl("p", { text: `Nothing is written until you've seen the dry run. Filters (${this.plugin.settings.screenOffOnly ? "screen off memos only" : "all notes"}, folders) come from the settings; dates filter on the ${this.plugin.settings.dateField} date.` });
    new Setting(c).setName("From").setDesc("YYYY-MM-DD; empty = from the beginning")
      .addText((t) => t.setPlaceholder("YYYY-MM-DD").setValue(this.since).onChange((v) => { this.since = v; this.invalidate(); }));
    new Setting(c).setName("To").setDesc("YYYY-MM-DD, inclusive; empty = no limit")
      .addText((t) => t.setPlaceholder("YYYY-MM-DD").setValue(this.until).onChange((v) => { this.until = v; this.invalidate(); }));
    new Setting(c)
      .addButton((b) => b.setButtonText("Dry run").setCta().onClick(() => void this.dryRun()))
      .addButton((b) => {
        this.batchBtn = b.buttonEl;
        b.setButtonText(`Import next ${this.plugin.settings.backfillBatchSize}`).setDisabled(true).onClick(() => void this.batch());
      });
    this.out = c.createEl("pre", { cls: "memo-bridge-report", text: "" });
  }

  private invalidate() { this.report = null; this.batchBtn?.toggleAttribute("disabled", true); }

  private async dryRun() {
    let range;
    try { range = this.range(); } catch (e) { new Notice((e as Error).message); return; }
    this.out.setText("Reading and rendering notes (nothing is written to the vault)…");
    try {
      const t0 = Date.now();
      this.report = await this.exclusive(() => this.engine.dryRun(range, (done, total) =>
        this.out.setText(`Reading and rendering notes (nothing is written to the vault)… ${done} / ${total}, ` +
          `${Math.round((Date.now() - t0) / 1000)} s`)));
      const text = formatDryRun(this.report);
      this.out.setText(text);
      const stamp = localIso(new Date()).slice(0, 19).replace(/[:T]/g, "-");
      const dir = this.plugin.reportsDir();
      fs.writeFileSync(path.join(dir, `dry-run-${stamp}.txt`), text + "\n");
      fs.writeFileSync(path.join(dir, `dry-run-${stamp}.json`), JSON.stringify(this.report, null, 1));
      this.plugin.log.info(`backfill dry run: ${this.report.toImport} to import; report saved in ${dir}`);
      this.batchBtn?.toggleAttribute("disabled", this.report.toImport === 0);
    } catch (e) {
      this.out.setText(`Dry run failed: ${(e as Error).message}`);
    }
  }

  private async batch() {
    if (!this.report) return;
    this.batchBtn?.toggleAttribute("disabled", true);
    try {
      const n = this.plugin.settings.backfillBatchSize;
      const r = await this.exclusive(() => this.engine.backfillBatch(this.range(), n));
      this.out.setText(`Imported ${r.written.length} notes${r.failed.length ? `, ${r.failed.length} failed (see log)` : ""}. ` +
        `${r.remaining} remaining.\nCheck them (e.g. on your phone), then import the next batch.\n\n` + r.written.join("\n"));
      this.batchBtn?.toggleAttribute("disabled", r.remaining === 0);
    } catch (e) {
      this.out.setText(`Batch failed: ${(e as Error).message}`);
    }
  }

  onClose() { this.contentEl.empty(); }
}

/** Generic confirm dialog: a message and a primary action button. */
export class ConfirmModal extends Modal {
  constructor(app: App, private title: string, private message: string, private action: string,
              private onConfirm: () => void) { super(app); }
  onOpen() {
    this.titleEl.setText(this.title);
    for (const para of this.message.split("\n\n")) this.contentEl.createEl("p", { text: para });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(this.action).setCta().onClick(() => { this.close(); this.onConfirm(); }));
  }
  onClose() { this.contentEl.empty(); }
}

/** One-time notice before a hosted recognition provider is used. */
export class HostedNoticeModal extends Modal {
  private accepted = false;
  constructor(app: App, private provider: string, private onAccept: () => void, private onCancel: () => void) { super(app); }
  onOpen() {
    this.titleEl.setText(`Send note images to ${this.provider}?`);
    const c = this.contentEl;
    c.createEl("p", { text: `With ${this.provider} selected, Memo Bridge sends an image of each handwritten page you choose to transcribe, together with the prompt (and your context hint, if any), to ${this.provider}'s servers. The answer (transcription and description) is written into your note.` });
    c.createEl("p", { text: "Usage is billed to your API key. Nothing is sent until you add folders to \"Folders allowed for hosted recognition\" (none by default). A note with memo_bridge_private: true in its frontmatter is never sent, and there is a daily page limit." });
    c.createEl("p", { text: "You can switch to a local provider (Ollama) at any time; then nothing leaves this computer." });
    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(`Use ${this.provider}`).setCta().onClick(() => { this.accepted = true; this.close(); this.onAccept(); }));
  }
  onClose() { this.contentEl.empty(); if (!this.accepted) this.onCancel(); }
}

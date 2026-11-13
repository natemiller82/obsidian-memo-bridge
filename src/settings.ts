import { App, PluginSettingTab, SecretComponent, Setting, Notice } from "obsidian";
import { HostedNoticeModal } from "./modals";
import { KEYED } from "./recognize/controller";
import { PRICES_AS_OF, SUGGESTED_MODELS, SUGGESTED_TEXT_MODELS, estimatePage } from "./recognize/pricing";
import { DEFAULT_URLS, PROVIDER_LABELS, type ProviderKind } from "./recognize/providers";
import type MemoBridgePlugin from "./main";
import { defaultLocalState } from "./paths";
import { parseSince, parseUntil, type Settings } from "./config";

export * from "./config";

export class MemoBridgeSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: MemoBridgePlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => { await this.plugin.saveSettings(); };
    containerEl.empty();

    containerEl.createEl("p", {
      text: "Memo Bridge copies notes from the Samsung Notes Windows app into this vault (one way: edits here are " +
        "never sent back). It reads Samsung's data folder outside the vault, and keeps its state, logs and " +
        "original-note backups outside the vault in %LOCALAPPDATA%\\memo-bridge.",
    });

    new Setting(containerEl).setName("Samsung Notes data folder")
      .setDesc(`Leave empty to use the default: ${defaultLocalState()}`)
      .addText((t) => t.setPlaceholder("auto-detect").setValue(s.localState).onChange(async (v) => { s.localState = v.trim(); await save(); }));

    new Setting(containerEl).setName("Target folder")
      .setDesc("Samsung's folders are mirrored under this vault folder.")
      .addText((t) => t.setValue(s.rootFolder).onChange(async (v) => { s.rootFolder = v; await save(); }));

    new Setting(containerEl).setName("Which notes")
      .addDropdown((d) => d.addOption("all", "All notes").addOption("screenoff", "Screen off memos only")
        .setValue(s.screenOffOnly ? "screenoff" : "all").onChange(async (v) => { s.screenOffOnly = v === "screenoff"; await save(); }));

    new Setting(containerEl).setName("Date range").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Applies to ongoing sync and to Backfill. Notes already imported keep receiving Samsung updates, and " +
        "changing the range never removes anything from the vault.",
    });
    new Setting(containerEl).setName("Filter on")
      .setDesc("Created: when the note was first written. Modified: also picks up an old note you edit today.")
      .addDropdown((d) => d.addOption("created", "Created date").addOption("modified", "Modified date")
        .setValue(s.dateField).onChange(async (v) => { s.dateField = v as Settings["dateField"]; await save(); }));
    const dateSetting = (name: string, desc: string, key: "since" | "until", parse: (v: string) => number | null) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => t.setPlaceholder("YYYY-MM-DD").setValue(s[key])
        .onChange(async (v) => {
          try { parse(v); s[key] = v.trim(); t.inputEl.removeClass("is-invalid"); await save(); }
          catch { t.inputEl.addClass("is-invalid"); }
        }));
    dateSetting("Sync notes on or after", "Lower bound. Empty = no limit.", "since", parseSince);
    dateSetting("…and on or before", "Optional upper bound, mainly for backfills.", "until", parseUntil);

    new Setting(containerEl).setName("Folders").setHeading();
    new Setting(containerEl).setName("Only these Samsung folders")
      .setDesc("One per line, e.g. \"Screen off memo\" or \"Work/Meetings\". Empty = all folders.")
      .addTextArea((t) => t.setValue(s.includeFolders).onChange(async (v) => { s.includeFolders = v; await save(); }));
    new Setting(containerEl).setName("Skip these Samsung folders")
      .setDesc("One per line. Skipping a folder also skips its subfolders.")
      .addTextArea((t) => t.setValue(s.excludeFolders).onChange(async (v) => { s.excludeFolders = v; await save(); }));

    new Setting(containerEl).setName("Rendering and polling").setHeading();
    new Setting(containerEl).setName("Ink scale")
      .setDesc("Thickness for the fountain-pen setting that the renderer draws too thin (other pens are corrected from a built-in table).")
      .addText((t) => t.setValue(String(s.inkScale)).onChange(async (v) => {
        const n = Number(v);
        if (n > 0 && n < 20) { s.inkScale = n; await save(); }
      }));
    new Setting(containerEl).setName("Poll interval (seconds)")
      .addText((t) => t.setValue(String(s.pollSeconds)).onChange(async (v) => {
        const n = Math.round(Number(v));
        if (n >= 5 && n <= 3600) { s.pollSeconds = n; await save(); }
      }));
    new Setting(containerEl).setName("Check Samsung's sync process")
      .setDesc("Warn when SamsungNotesSysTray (which brings notes from your phone to this PC) isn't running. " +
        "This runs Windows' tasklist every 10 minutes; it is the only program the plugin starts.")
      .addToggle((t) => t.setValue(s.checkSamsungSync).onChange(async (v) => { s.checkSamsungSync = v; await save(); }));
    new Setting(containerEl).setName("Backfill batch size")
      .addText((t) => t.setValue(String(s.backfillBatchSize)).onChange(async (v) => {
        const n = Math.round(Number(v));
        if (n >= 1 && n <= 500) { s.backfillBatchSize = n; await save(); }
      }));
    new Setting(containerEl).setName("Debug logging")
      .addToggle((t) => t.setValue(s.debugLog).onChange(async (v) => { s.debugLog = v; await save(); }));
    new Setting(containerEl).setName("Log file").setDesc(this.plugin.data.logFile)
      .addButton((b) => b.setButtonText("Show log").onClick(() => this.plugin.showLog()));
    new Setting(containerEl).setName("Sync now")
      .addButton((b) => b.setButtonText("Sync now").setCta().onClick(() => { void this.plugin.syncNow(); new Notice("Memo Bridge: syncing…"); }));

    this.recognition(containerEl, save);
  }

  private recognition(containerEl: HTMLElement, save: () => Promise<void>) {
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Text recognition and alt text").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Optional and off by default. A vision model transcribes each handwritten page and describes it; the result " +
        "is added to the note in a collapsed, clearly marked machine-generated section, with a short description in " +
        "the alt_text property. Ollama runs on this computer. The other providers are online services: page images " +
        "are sent to them, billed to your API key.",
    });

    new Setting(containerEl).setName("Provider")
      .addDropdown((d) => {
        d.addOption("none", "Off");
        for (const [k, label] of Object.entries(PROVIDER_LABELS)) d.addOption(k, label);
        d.setValue(s.recProvider).onChange(async (v) => {
          const kind = v as ProviderKind | "none";
          const prev = s.recProvider;
          const hostedKind = kind === "anthropic" || kind === "openai" || kind === "gemini";
          if (hostedKind && !s.recAcknowledged.includes(kind)) {
            new HostedNoticeModal(this.app, PROVIDER_LABELS[kind],
              async () => { s.recAcknowledged = [...s.recAcknowledged, kind]; s.recProvider = kind; await save(); this.display(); },
              () => { d.setValue(prev); }).open();
            return;
          }
          s.recProvider = kind;
          await save();
          this.display();
        });
      });
    if (s.recProvider === "none") return;
    const kind = s.recProvider;
    const hosted = kind === "anthropic" || kind === "openai" || kind === "gemini";

    if (kind === "ollama" || kind === "openai-compatible")
      new Setting(containerEl).setName(kind === "ollama" ? "Ollama URL" : "Base URL")
        .setDesc(kind === "ollama" ? "Where Ollama listens. Anything other than localhost counts as a hosted provider."
          : "Up to /v1, e.g. http://localhost:1234/v1 (LM Studio) or https://openrouter.ai/api/v1. Anything other than localhost counts as a hosted provider.")
        .addText((t) => t.setPlaceholder(DEFAULT_URLS[kind] ?? "").setValue(s.recUrls[kind] ?? "")
          .onChange(async (v) => { s.recUrls = { ...s.recUrls, [kind]: v.trim() }; await save(); }));

    if (KEYED.includes(kind))
      new Setting(containerEl).setName("API key")
        .setDesc("Kept in Obsidian's secret storage (Settings → Keychain), not in this plugin's settings file. " +
          (kind === "openai-compatible" ? "Leave empty if the endpoint doesn't need one." : ""))
        .addComponent((el) => new SecretComponent(this.app, el).setValue(s.recSecretIds[kind] ?? "")
          .onChange(async (v) => { s.recSecretIds = { ...s.recSecretIds, [kind]: v ?? "" }; await save(); }));

    const listId = `memo-bridge-models-${kind}`;
    const modelSetting = new Setting(containerEl).setName("Model")
      .setDesc("Reads each page: transcription, description and alt text. Type a model name, or click Refresh to list the provider's models (vision-capable ones first).")
      .addText((t) => {
        t.setPlaceholder(SUGGESTED_MODELS[kind]?.[0] ?? "").setValue(s.recModels[kind] ?? "")
          .onChange(async (v) => { s.recModels = { ...s.recModels, [kind]: v.trim() }; await save(); this.costLine(cost, kind); });
        t.inputEl.setAttr("list", listId);
      });
    const datalist = modelSetting.controlEl.createEl("datalist", { attr: { id: listId } });
    for (const m of SUGGESTED_MODELS[kind] ?? []) datalist.createEl("option", { attr: { value: m } });
    modelSetting.addButton((b) => b.setButtonText("Refresh").onClick(async () => {
      b.setDisabled(true);
      try {
        const models = await this.plugin.rec!.providerFor(kind).listModels();
        models.sort((a, b2) => Number(b2.vision === true) - Number(a.vision === true) || a.id.localeCompare(b2.id));
        datalist.empty();
        for (const m of models) datalist.createEl("option", { attr: { value: m.id,
          label: [m.vision === false ? "no image input" : m.vision ? "reads images" : "", m.note ?? ""].filter(Boolean).join(" · ") } });
        new Notice(`Memo Bridge: ${models.length} models (${models.filter((m) => m.vision).length} marked as reading images).`);
      } catch (e) {
        new Notice(`Memo Bridge: couldn't list models: ${(e as Error).message}`, 10_000);
      } finally { b.setDisabled(false); }
    }));
    const textListId = `memo-bridge-text-models-${kind}`;
    const textSetting = new Setting(containerEl).setName("Transcription model (optional)")
      .setDesc((kind === "ollama"
        ? "Suggested: glm-ocr here (ollama pull glm-ocr, about 3 GB) with qwen3-vl:8b-instruct above; in testing it made about half as many word errors as one model. "
        : "") + "A second model on the same provider that only transcribes; the model above then writes only the description and alt text. " +
        "Each page goes to both models, so it takes a little longer. Empty: one model does everything.")
      .addText((t) => {
        t.setPlaceholder(kind === "ollama" ? "none (suggested: glm-ocr)" : "none").setValue(s.recTextModels[kind] ?? "")
          .onChange(async (v) => { s.recTextModels = { ...s.recTextModels, [kind]: v.trim() }; await save(); this.costLine(cost, kind); });
        t.inputEl.setAttr("list", textListId);
      });
    const textList = textSetting.controlEl.createEl("datalist", { attr: { id: textListId } });
    for (const m of SUGGESTED_TEXT_MODELS[kind] ?? []) textList.createEl("option", { attr: { value: m } });
    const cost = containerEl.createEl("p", { cls: "setting-item-description" });
    this.costLine(cost, kind);

    new Setting(containerEl).setName("Transcribe new notes automatically")
      .setDesc("Off: transcribe only when you run a Transcribe command.")
      .addToggle((t) => t.setValue(s.recAutoRun).onChange(async (v) => { s.recAutoRun = v; await save(); }));

    new Setting(containerEl).setName("Context hint")
      .setDesc("Optional. Added to the prompt to help with unfamiliar words, e.g. \"Lecture notes in organic chemistry; expect chemical names.\"")
      .addTextArea((t) => t.setValue(s.recContextHint).onChange(async (v) => { s.recContextHint = v; await save(); }));

    if (hosted || this.plugin.rec?.provider()?.hosted) {
      new Setting(containerEl).setName("Folders allowed for hosted recognition")
        .setDesc("Samsung folders, one per line (subfolders included; \"Uncategorized\" = notes without a folder). " +
          "Empty = nothing is sent. Add memo_bridge_private: true to a note's properties to keep it from ever being sent.")
        .addTextArea((t) => t.setValue(s.recHostedFolders).onChange(async (v) => { s.recHostedFolders = v; await save(); }));
      new Setting(containerEl).setName("Daily limit (pages)")
        .setDesc("At most this many pages are sent to a hosted provider per day; the queue waits until tomorrow after that.")
        .addText((t) => t.setValue(String(s.recHostedDailyPages)).onChange(async (v) => {
          const n = Math.round(Number(v));
          if (n >= 0 && n <= 100_000) { s.recHostedDailyPages = n; await save(); }
        }));
    }
    new Setting(containerEl).setName("Never recognise these folders")
      .setDesc("Samsung folders, one per line. Applies to every provider, including Ollama.")
      .addTextArea((t) => t.setValue(s.recExcludeFolders).onChange(async (v) => { s.recExcludeFolders = v; await save(); }));
    new Setting(containerEl).setName("Alt text in the image embed")
      .setDesc("Also write the description into the page image embed (![[page.svg|description]]) so screen readers announce it " +
        "with the image. Only for notes you haven't edited. Off: the description is in the alt_text property and the section.")
      .addToggle((t) => t.setValue(s.recAltInEmbed).onChange(async (v) => { s.recAltInEmbed = v; await save(); }));

    const status = new Setting(containerEl).setName("Status").setDesc(this.plugin.rec?.statusLine() ?? "not running");
    status.addButton((b) => b.setButtonText("Test connection").onClick(async () => {
      try {
        const n = (await this.plugin.rec!.providerFor(kind).listModels()).length;
        new Notice(`Memo Bridge: connected to ${PROVIDER_LABELS[kind]} (${n} models).`);
      } catch (e) {
        new Notice(`Memo Bridge: ${PROVIDER_LABELS[kind]}: ${(e as Error).message}`, 10_000);
      }
    }));
  }

  private costLine(el: HTMLElement, kind: ProviderKind) {
    const model = this.plugin.settings.recModels[kind] ?? "", text = (this.plugin.settings.recTextModels[kind] ?? "").trim();
    const desc = estimatePage(kind, model), second = text ? estimatePage(kind, text) : 0;
    const per = desc === null || second === null ? null : desc + second;
    el.setText(kind === "ollama" ? "Runs on this computer; no cost per page." :
      per === null ? (model ? "No price known for this model, so no cost estimate." : "") :
      `About $${per.toFixed(4)} per page at list prices as of ${PRICES_AS_OF}.`);
  }
}

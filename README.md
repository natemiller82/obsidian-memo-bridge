# Memo Bridge

An [Obsidian](https://obsidian.md) plugin that copies your notes from the **Samsung Notes app for
Windows** into your vault, one way: handwriting becomes an SVG image, typed text becomes Markdown,
and Samsung's folders are mirrored under one vault folder.

> **Unofficial.** Memo Bridge is an independent project. It is not made, endorsed or supported by
> Samsung, and "Samsung Notes" is used only to say what it works with. It reads a reverse-engineered
> file format, so some notes are imported imperfectly (see [Known limits](#known-limits)).

## What it does

- Watches Samsung Notes' local data while Obsidian is open and imports new and changed notes.
  On start-up it catches up on everything that arrived while Obsidian was closed.
- Handwriting → SVG (cropped, on a rounded card in the page colour); typed text → Markdown
  (bold, underline and highlight kept); multi-page notes → one image per page; images and PDFs
  attached to a note are copied next to it.
- Each note gets frontmatter: `created`, `modified`, `samsung_note_id`, `folder`, `source`,
  `content`, `render`, `revision`.
- **Never overwrites your edits.** If Samsung changes a note you've edited in Obsidian, the update is
  written as a new file (`Note.r2.md`) and yours is left alone.
- **Never deletes anything.** Notes deleted in Samsung stay in your vault.
- **One way only.** Nothing you do in Obsidian is sent back to Samsung Notes.
- Optional backfill of older notes, with a dry-run report first and import in batches.

## Requirements

- **Windows 10 or 11** with the **Samsung Notes** app from the Microsoft Store, signed in to your
  Samsung account and syncing. Notes reach the PC through Samsung's background process
  `SamsungNotesSysTray`; the Samsung Notes window doesn't need to be open.
- **Obsidian desktop 1.11.4 or newer, installed with installer 1.9.12 or newer.** The plugin uses
  the SQLite built into Obsidian's runtime (Electron 37.3 or newer) and Obsidian's secret storage
  for API keys. The app updates itself, but the *installer* (which carries Electron) does not:
  1. In Obsidian, open **Settings → General** and look at **Installer version**.
  2. If it is older than **1.9.12**, download the current installer from
     [obsidian.md/download](https://obsidian.md/download) and run it. Your vaults and settings are
     kept.
  If the installer is too old, the plugin shows a notice and does nothing.
- Not available on mobile (`isDesktopOnly`).

## Install

Until it is listed in Community plugins:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest
   [release](../../releases).
2. Put them in `<your vault>/.obsidian/plugins/memo-bridge/`.
3. In Obsidian: **Settings → Community plugins** → turn on community plugins if asked →
   enable **Memo Bridge**.

On first start it imports only notes created **from that moment on**. Older notes are imported only
when you run **Backfill** (below).

## Using it

**Status bar** (bottom right): last sync time, notes still arriving, and ⚠ if something needs
attention (hover for details, click to sync now).

**Commands** (Ctrl+P):

| Command | What it does |
|---|---|
| Memo Bridge: Sync now | Check for new or changed notes immediately. |
| Memo Bridge: Backfill since date… | Dry run (counts, size, which notes fall back to thumbnails, which are skipped and why), then import in batches you start one at a time. |
| Memo Bridge: Pause / resume syncing | Stop or restart automatic syncing. |
| Memo Bridge: Open log | Show the end of the log. |
| Memo Bridge: Re-render this note / notes drawn with an older pen table… | Redraw imported notes with the current pen corrections. Notes you haven't edited are updated in place; edited ones get a new revision file next to them. |
| Memo Bridge: Transcribe this note | Queue the open note for text recognition (if enabled; see below). |
| Memo Bridge: Transcribe all untranscribed notes… | Shows how many notes and pages, the estimated cost for an online provider, and what won't be sent; queues them after you confirm. |
| Memo Bridge: Re-run transcription… (this note / notes done with a different model) | Transcribe again with the current provider and model. |

**Settings:**

| Setting | Default | Notes |
|---|---|---|
| Samsung Notes data folder | auto-detected | Only change if Samsung Notes is installed somewhere unusual. |
| Target folder | `Samsung Notes` | Samsung's folders are mirrored below it; notes without a folder go to `Uncategorized`. |
| Which notes | All notes | Or *Screen off memos only*. |
| Filter on | Created date | Or *Modified date*, which also picks up an old note you edit today. |
| Sync notes on or after / on or before | install time / none | Applies to sync and Backfill. Imported notes keep receiving Samsung updates; changing the range never removes anything. |
| Only these / Skip these Samsung folders | (empty) | One per line; subfolders included. |
| Ink scale | 2.6 | Thickness for the one fountain-pen setting the renderer draws too thin. Other pens use a built-in table. |
| Poll interval | 30 s | |
| Check Samsung's sync process | on | See below. |
| Backfill batch size | 25 | |

## Text recognition and alt text (optional, off by default)

Memo Bridge can ask a vision model to transcribe your handwriting and describe each page (for
screen readers and search). **It is off until you choose a provider** in the settings, and even
then it only runs on new notes if you turn on *Transcribe new notes automatically*; otherwise only
when you run a Transcribe command.

- **What is added to a note:** a collapsed, clearly marked machine-generated section (the
  transcription, unreadable words marked `[?]`, a sentence about any drawing, and a description),
  plus properties `transcribed_by`, `transcribed_at`, `transcription_version`,
  `transcription_language` and `alt_text`. The images are never changed. If you've edited the
  note, the result goes to a separate `….enrich-transcribe.md` next to it instead. Optionally (off by
  default) the description is also written into the image embed of notes you haven't edited.
- **Never guesses silently:** a page without handwriting gets "No handwritten text", not invented
  text; answers that break this rule are rejected and retried.
- **Runs in the background,** one note at a time, and never holds up syncing. If the provider is
  unreachable it pauses quietly and tries again later; a failed note is retried, never marked done.

**Providers** (pick one; the model is a setting):

| Provider | Where your page images go | Needs | Their terms |
|---|---|---|---|
| Ollama | Nowhere: Ollama runs on your computer (default URL `http://localhost:11434`). | Ollama with a vision model, e.g. `ollama pull qwen3-vl:8b-instruct` (about 6 GB) | – |
| Anthropic (Claude) | Anthropic's API (`api.anthropic.com`) | An Anthropic API key (billed to you) | [Privacy policy](https://www.anthropic.com/legal/privacy), [commercial terms](https://www.anthropic.com/legal/commercial-terms) |
| OpenAI | OpenAI's API (`api.openai.com`) | An OpenAI API key (billed to you) | [Privacy policy](https://openai.com/policies/privacy-policy/), [API data](https://openai.com/enterprise-privacy/) |
| Google Gemini | Google's Gemini API (`generativelanguage.googleapis.com`) | A Gemini API key (billed to you) | [Privacy policy](https://policies.google.com/privacy), [Gemini API terms](https://aistudio.google.com/docs/terms) |
| OpenAI-compatible | The URL you enter (e.g. LM Studio on your computer, or OpenRouter) | Depends on the service | The service's own |

What the online providers do with what you send is set by their terms, not by this plugin; read
them before choosing one. In particular, Google's terms say that on the Gemini API's **unpaid**
tier your input may be used to improve Google's products and read by human reviewers, and ask you
not to send sensitive or personal information there; the paid tier doesn't do either.

**Two models (optional; suggested on Ollama):** set a *Transcription model* next to the main
model to have one model transcribe and the other describe each page. The suggested Ollama setup is
`glm-ocr` (about 3 GB, `ollama pull glm-ocr`) as the transcription model and `qwen3-vl:8b-instruct`
as the main model. On 21 handwritten pages from the author's own notes it got about 20% of words
wrong, against 41% for `qwen3-vl:8b-instruct` alone; your handwriting and pens may give different
results. One model stays the default. OCR-only models (with "ocr" in
the name) get their own plain text-recognition task. Each page goes to both models, so it takes a
bit longer, and for online providers costs and counts against the daily limit twice. If the
transcription model finds no text but the main model did, the main model's text is kept.

**Online providers** (anything that isn't on your own computer) get extra safeguards:

- **A one-time notice** when you first select one, saying what is sent.
- **An allow-list of folders**, empty by default, so nothing is sent until you add folders.
- **Private notes stay local:** a note with `memo_bridge_private: true` in its properties is never
  sent.
- **A daily page limit** (default 25).
- **What is sent:** for each page, an image of the handwriting (dark ink on white, made from the
  note's strokes and cropped to them, about 1600 px; for old notes, Samsung's thumbnail cropped to
  the writing) and the instructions, including your optional *context hint*.
  Nothing else from your vault is sent: no file names, no other notes. The answer is written into
  the note as described above.

**API keys** are stored in Obsidian's own secret storage (**Settings → Keychain**), not in the
plugin's `data.json`, so vault sync tools don't copy them.

## What it does outside your vault

You should know exactly what a plugin touches. Memo Bridge:

- **Reads Samsung Notes' data folder**,
  `%LOCALAPPDATA%\Packages\SAMSUNGELECTRONICSCoLtd.SamsungNotes_wyx1vj98g3asy\LocalState`. It never
  writes there: the database is *copied* and only the copy is opened.
- **Writes its own folder, `%LOCALAPPDATA%\memo-bridge\`**, kept out of the vault so sync tools
  don't carry it to your phone:
  - `state.sqlite`: which notes were imported (prevents duplicates)
  - `sdocx\`: an untouched backup of every imported note version (`.sdocx`), so notes can be
    re-rendered later with full fidelity
  - `model-input\`: an unmodified SVG/PNG of each page
  - recognition progress (queue, which model transcribed what, pages sent per day) in
    `state.sqlite`
  - `snap\`: the working copy of Samsung's database
  - `logs\plugin.log` and `reports\` (backfill dry runs)
- **Starts one program:** Windows' `tasklist`, every 10 minutes, to check that
  `SamsungNotesSysTray` is running. Turn **Check Samsung's sync process** off and it starts nothing.
- **Makes no network requests unless you turn on text recognition,** and then only to the provider
  you chose (see above): to your own computer for Ollama, or to that company's API for an online
  provider. It never collects telemetry.

Inside the vault it only creates notes and attachments under the target folder (plus, with text
recognition on, the transcription section in those notes or a `….enrich-transcribe.md` next to a
note you've edited), and the plugin's own `data.json` (your settings; never API keys).

## Known limits

- **Pen fidelity.** Samsung's pens are drawn by an independent renderer
  ([sdocx](https://github.com/twangodev/sdocx)). Several pens come out thinner or more opaque than
  in Samsung Notes; Memo Bridge corrects them from a table measured against Samsung's own
  full-size rendering, but:
  - the pencil has no grain texture;
  - the calligraphy pen's angled nib is drawn as an even line;
  - the calligraphy brush doesn't follow pen pressure: light strokes look heavier and firm strokes
    thinner than in Samsung;
  - the fountain pen in notes written with older versions of Samsung Notes may still be drawn too
    thin or too thick (the correction is being measured).

  The original strokes are always kept in the `.sdocx` backup.
- **Older notes.** Many notes created before about 2022 use a storage layout the renderer can't read
  yet. Those are imported as Samsung's own **thumbnail of the first page** plus any typed text, and
  marked `render: thumbnail`; pages after the first are not shown. They can be re-rendered later
  from the backup when the renderer improves.
- **Page backgrounds** such as the yellow Action memo paper are not reproduced.
- **Locked notes** are skipped and listed in the log; they are never opened.
- **Text formatting:** bold, underline and highlight are kept; font size, colour and alignment are
  not.
- **One way only**, and **Windows only**.

## Development

This project was built with AI assistance under my direction and review.

```powershell
npm ci
npm run typecheck
npm test            # tests use synthetic fixtures only
npm run build       # -> main.js (refuses anything but the pinned renderer)
npm run verify      # check the renderer embedded in main.js
$env:MEMO_BRIDGE_VAULT = "C:\path\to\test-vault"; npm run dev-install
```

The build is reproducible and the embedded renderer is pinned and verifiable; see
[BUILD.md](BUILD.md).

The repo blocks commits that contain secrets or personal data (gitleaks):

```powershell
node scripts/get-gitleaks.mjs        # pinned, checksum-verified, into tools/ (gitignored)
git config core.hooksPath .githooks
```

Put your own name, e-mail and Samsung device id prefixes in `.gitleaks.local.toml` (gitignored);
it extends the repo rules in `.gitleaks.toml`. CI runs the same scan.

Tests run on synthetic fixtures in `test/fixtures`: throwaway notes with every identifier
replaced. Never add real notes, note ids, thumbnails, renders, databases or logs to the repo.

### Recognition evaluation harness

Compares providers, models and prompt variants on your own notes. Everything it writes goes to
`local/eval/`, which is gitignored.

```powershell
npm run eval -- pick                      # choose ~20 notes covering the pen types and note kinds; writes their recognition images
npm run eval -- images --variant final       # rebuild the set's images with the current code (local/eval/variants/final)
npm run eval -- run --provider ollama --model qwen3-vl:8b-instruct [--hint] [--mode json|ocr] [--images final] [--missing]
npm run eval -- review                    # local/eval/review.html: correct the drafts once (saves p<n>.truth.txt)
npm run eval -- report                    # local/eval/report.md: CER/WER against your corrections, agreement, speed, cost; OCR + JSON runs also combined as two-model setups
```

One run at a time: a second run refuses to start while one is active, and the Ollama model is unloaded when a run ends or is stopped. `--missing` resumes a stopped run.

`--hint` adds the context hint from `local/eval/hint.txt` (gitignored, since it describes your own notes).

Online providers need `--allow-hosted` and a key in an environment variable (`MB_ANTHROPIC_KEY`,
`MB_OPENAI_KEY` or `MB_GEMINI_KEY`); without the flag the harness refuses to send anything off
your computer. Look through the chosen notes in `review.html` before any online run.

## License

[GPL-3.0-or-later](LICENSE). The plugin bundles
[@twango/sdocx](https://github.com/twangodev/sdocx) (GPL-3.0) and
[@xmldom/xmldom](https://github.com/xmldom/xmldom) (MIT).

Samsung and Samsung Notes are trademarks of Samsung Electronics Co., Ltd. Obsidian is a trademark of
Dynalist Inc. This project is not affiliated with either.

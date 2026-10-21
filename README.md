# dsh-officecli-connection

A thin DeepSeek Harness shell around a **locally installed** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) binary.

The plugin ships no binary, downloads nothing, and updates nothing. You install OfficeCLI yourself; the plugin only learns where it is and gives the agent a clean way to call it.

## What it adds

| Piece | Detail |
| --- | --- |
| Settings page | **Settings → OfficeCLI**: binary path, a skill toggle, and a Test button that reports the detected version. |
| `officecli` tool | One tool, parameter `command` (a command line or pre-split argv). The process starts in the **session working directory**, so relative paths behave like a shell. Rendered pages come back as image attachments. |
| Skills | OfficeCLI's ten bundled skills (`pptx`, `word`, `excel`, `word-form`, `morph-ppt`, `morph-ppt-3d`, `pitch-deck`, `academic-paper`, `data-dashboard`, `financial-model`) are exposed as runtime skills. Names follow the skill's own id, so `word` surfaces as `officecli-docx` and `excel` as `officecli-xlsx` — the way the other skill bodies cross-reference them. The desktop build's own seven office skills are hidden by default so only one stack is in play (see *Hiding the built-in office skills*). |

Skills are injected through the Harness skill-provider contract, so **no file is ever written anywhere**: no workspace, no `.agents/`, no `~/.claude`. The catalog comes from `officecli load_skill` and a body from `officecli load_skill <slug>`, both of which print to stdout. Bundled reference files stay loadable through the skill's `resourceBase`, which tells the agent to run `officecli load_skill <slug> --path <relpath>`.

## Boundary: what happens to output

| Channel | Treatment |
| --- | --- |
| stdout | passed through verbatim as the text block, truncated at 8 MB |
| stderr | appended to that text; never parsed, never dropped |
| exit code | passed through unchanged; no retry, no reinterpretation. `2` means "ran with caveats": read `warnings`, `success` can be false |
| a line naming an existing image file | committed as a durable attachment and returned as an image block; over a deployment size limit you get the path plus a note |
| everything else | untouched — no JSON parsing, no HTML rendering, no file watching |

The tool description deliberately carries **no flag reference**. It tells the model to run `officecli help`, `help <verb>` and `help <format> <element>`, because the binary is the authoritative schema and any hardcoded flag list drifts with the version. What it does carry is the short list of traps below — the ones that cost a real document build.

## Known upstream behaviour

Reproduced against OfficeCLI 1.0.158. None of this is the plugin's own design; the tool description repeats it so the model does not rediscover it on every document.

| Behaviour | What to do |
| --- | --- |
| The binary runs **argv, not a shell** | no `&&`, `\|`, `>`, `$VAR`; one command per call, or put the steps in `batch` |
| Lengths carry units | `1.45cm`, `10.6cm,6.4cm`, `12pt`; a bare number exits 1 |
| Fonts are per script | set `font.latin` **and** `font.ea`; a lone `font` leaves CJK on a monospace fallback |
| Table defaults are close to unusable | `border.all=none` plus `border.horizontal`, and an explicit header fill, or the header text is invisible |
| Write verbs keep a resident process | another reader meanwhile gets "being used by another process"; run `close <file>` when done |
| xlsx screenshots are an HTML approximation | charts and merged cells can overlap or clip while the workbook is correct; confirm with `view text --range` and `view issues` |
| `view issues` has a false positive | a horizontal `INDEX(..., MATCH(...))` can be reported as `#REF!` while the cached value is right |

## Hiding the built-in office skills

A desktop build also mounts `@deepseek-ai/dsh-skill-office` — seven skills (`office`, `office-docx`, `office-xlsx`, `office-pptx`, `office-render`, `office-export-pdf`, `office-recalculate`) that render and export through **LibreOffice Kit** and edit files through the Python libraries.

That stack is mounted by the desktop host from `resources/runtime/office-skills`, *outside* the profile composition. It is therefore not a loader row: it does not appear in `configEditor.entries()`, `plugin_manager` cannot address it, a `cordis.patch.yml` override for `skill-office` has nothing to attach to, and the `skills` service offers no disable call — only `registerProvider`, `register`, `list`, `snapshot` and `get`.

The one lever left is the catalog's own duplicate resolution. With the switch on, this plugin publishes an entry under each of those seven names with `modelInvocable: false`. On the current build the catalog resolves a duplicate name to the **provider that was registered last**, so those entries replace the built-in ones and the built-in guides stop reaching the model entirely.

| Switch | Model sees | When to pick it |
| --- | --- | --- |
| **Hide on** (default) | only this plugin's 10 skills; all seven `office-*` names resolve to non-invocable shadows | one stack, no duplicate guides, no ambiguity about which manual to follow |
| **Hide off** | 7 built-in + 10 from this plugin | you want the LibreOffice route back without uninstalling anything |

Both directions are verified against a live desktop profile: `hide off` → seven visible, `hide on` → zero visible, and the catalog rebuilds in place with no restart.

The toggle lives in **Settings → OfficeCLI → Hide the built-in office-* skills**, and the settings page reports which way resolution went (`Built-in guides are hidden` versus `still visible`). That readout exists because this is an empirical bet on the resolver's tie-breaking: if a future build registers providers in a different order or rejects duplicate names, the switch degrades to a no-op and says so instead of silently doing nothing.

Detection of "is the built-in stack installed" is a synchronous directory check (`<resources>/runtime/office-skills`) rather than a lookup in the skills service — a provider that awaits `skills.snapshot()` from inside `list()` deadlocks the catalog, and with it the whole session.


## Why not MCP

OfficeCLI's own `officecli mcp` server exposes exactly one tool whose only parameter is a command-line string, so an MCP hop buys nothing here but adds a second process, a serialization quirk (array arguments arrive as a bracketed string), and an unconfigurable working directory. Registering the tool directly lets the plugin spawn with `cwd` set to the session directory and re-read the configured path on every call, so editing the path takes effect without a restart.

## Install

```sh
# from a checkout
dsh plugin --profile desktop add <path-to-this-directory>
```

Or install the bundle through the Harness plugin manager UI and enable it.

## Configure

1. Install the OfficeCLI build for the platform **this harness runs on** (see upstream releases): `officecli-win-x64.exe` on Windows, `officecli-linux-x64` on Linux, `officecli-mac-arm64` on Apple silicon.
2. Open **Settings → OfficeCLI**.
3. Fill in the binary path, e.g. `C:\Users\you\officecli\officecli.exe`.
4. **Test**, then **Save**.

Settings live in `$DSH_HOME/officecli-connection/settings.json`.

## One platform, one build

The plugin spawns the configured binary **directly** — no `wsl.exe` bridge, no `/mnt/c/` path translation, no distribution selector. A Windows harness runs the Windows build; a harness running inside WSL or on Linux runs the Linux build. Pointing a Windows harness at a Linux path is rejected with an explicit message instead of a bare `ENOENT`.

## Runtime notes

- **Resident processes**: each tool call is one short-lived process; the binary may keep the file open in a background resident, which blocks other processes from reading it. Either chain edits with `batch` or finish with `close <file>`.
- **Rendering**: `view ... screenshot|html|pdf` needs a rendering backend and the document's fonts. The core commands (`get`, `set`, `add`, `remove`, `query`, `batch`, `validate`, `dump`, `merge`, `view text|outline|stats|issues`) do not. The tool description tells the model which is which; the plugin does not try to install fonts or browsers.
- **Screenshots travel with the result**: when a command prints the path of an image it just wrote, the plugin commits that file as a durable attachment and returns it as an image block. The printed path stays in the text block, so a model that cannot receive images — or a deployment with a tighter size limit — still gets an actionable fallback (`read_image`), and an over-limit or failed attachment is reported as a note instead of an error.

## Uninstall

Disable or remove the bundle. The injected skills, tool, and settings page disappear with it. The only file left behind is `$DSH_HOME/officecli-connection/settings.json`, which you can delete; nothing was ever written into a workspace or into another agent's skill directory.

## License

MIT for this plugin. OfficeCLI itself is Apache-2.0 and is **not** redistributed here.

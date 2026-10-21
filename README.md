# dsh-officecli-connection

A thin DeepSeek Harness shell around a **locally installed** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) binary.

The plugin ships no binary, downloads nothing, and updates nothing. You install OfficeCLI yourself; the plugin only learns where it is and gives the agent a clean way to call it.

## What it adds

| Piece | Detail |
| --- | --- |
| Settings page | **Settings → OfficeCLI**: binary path, a skill toggle, and a Test button that reports the detected version. |
| `officecli` tool | One tool, parameter `command` (a command line or pre-split argv). The process starts in the **session working directory**, so relative paths behave like a shell. Rendered pages come back as image attachments. |
| Skills | OfficeCLI's ten bundled guides (`pptx`, `word`, `excel`, `word-form`, `morph-ppt`, `morph-ppt-3d`, `pitch-deck`, `academic-paper`, `data-dashboard`, `financial-model`) are exposed as runtime skills. Names follow the skill's own id, so `word` surfaces as `officecli-docx` and `excel` as `officecli-xlsx` — the way the other skill bodies cross-reference them. One extra entry, `officecli`, is this plugin's own: it maps the ten and states the workflow boundary (see *Coexisting with other Office skills*). |

Skills are injected through the Harness skill-provider contract, so **no file is ever written anywhere**: no workspace, no `.agents/`, no `~/.claude`. The catalog comes from `officecli load_skill` and a body from `officecli load_skill <slug>`, both of which print to stdout. Bundled reference files stay loadable through the skill's `resourceBase`, which tells the agent to run `officecli load_skill <slug> --path <relpath>`.

With the skill toggle **off**, `officecli` and all ten guides leave the catalog together — the model then works from `help` and the tool description alone. Files stay valid; what goes missing is the house style (layout floors, palettes, element canon, per-format verification), so a deliverable comes out plainer rather than broken. The settings page says exactly this when the box is unchecked, and the tool description tells the model to admit it rather than invent a guide that is not there.

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
| Long or non-ASCII arguments belong in a file | `batch <file> --input <json>`; inline quoting breaks eventually and silently — a serialised argv array reaches the CLI as the literal token `[batch,` |
| A bare length is EMU, not an error | `margin=26` collapses the box while `validate` still passes; write `pt`/`cm`. `spacing` is the opposite: unitless points |
| `add` and `set` disagree on property names | `add` takes `w`/`h`, `set` takes `width`/`height`; a wrong name only prints `UNSUPPORTED props`, and the call still exits 0 |
| `batch` rolls back on failure | one bad item discards the others, yet the summary line still counts them as succeeded |
| Fonts are per script | set `font.latin` **and** `font.ea`; a lone `font` leaves CJK on a monospace fallback |
| Table defaults are close to unusable | `border.all=none` plus `border.horizontal`, and an explicit header fill, or the header text is invisible |
| Write verbs keep a resident process | another reader meanwhile gets "being used by another process"; run `close <file>` when done |
| `validate` checks the package, not the layout | a table can overflow the slide and still pass; only a screenshot shows it — text that overflows a box is clipped or wrapped out of sight, at any font size |
| xlsx screenshots are an HTML approximation | charts and merged cells can overlap or clip while the workbook is correct; confirm with `view text --range` and `view issues` |
| A formula condition with quotes | write `\">1\"` (or pass the argv array): the plain string form strips the quotes, the cell keeps `#OCLI_NOTEVAL!`, and the call still reports success |
| A formula written across a range | relative references are not shifted — `set /Sheet1!D1:D3 --prop formula=A1*2` stores `A1*2` three times; one op per cell |
| Changing a precedent deletes its cached value | `view issues` answers "can this be evaluated", not "what is cached"; `<x:calcPr fullCalcOnLoad="1"/>` makes Excel recompute on open |
| `colWidths` is fixed at table creation | it cannot be changed afterwards, and `add` only appends to the end of the body — estimate widths and build the document as one batch |
| `create` leaves the style part empty | set `Normal`/`Heading` fonts in the first batch, or CJK silently falls back to `等线`; only `view stats`' Font Usage shows it |
| `view text` does not expand table cells | it prints `[Table: 9 rows]`; read the content with `get /body/tbl[1]/tr[N]` |
| A screenshot page past the end | returns page 1 unchanged instead of failing; xlsx screenshots also need a headless browser (docx and pptx do not) |
| `view issues` has a false positive | a horizontal `INDEX(..., MATCH(...))` can be reported as `#REF!` while the cached value is right |

## Coexisting with other Office skills

A desktop build also mounts `@deepseek-ai/dsh-skill-office` — seven skills (`office`, `office-docx`, `office-xlsx`, `office-pptx`, `office-render`, `office-export-pdf`, `office-recalculate`) that render and export through **LibreOffice Kit** and edit files through the Python libraries. A third-party plugin can add a third stack nobody enumerates.

This plugin used to try to hide that stack: publish same-named entries with `modelInvocable: false` and hope the catalog prefers them. That worked against the current build, and it was still the wrong design — hiding only covers the providers you can enumerate, so the first unknown Office plugin makes the switch lie. It is gone.

What replaced it is knowledge the model can use on its own:

| Piece | What it says |
| --- | --- |
| Skill names | `officecli-*` — mechanically separable from any other family in the catalog |
| Skill `officecli` | the workflow entry point: which guide handles which format, that all of them drive this tool, that another provider's skills are a different engine, and why one file must not be started by one engine and finished by another |
| Tool description | the same boundary in the place the model reads before it picks a tool |

The settings page states this in one line instead of offering a switch, because there is nothing here that can be switched.

One rule this plugin still honours: a skill provider must never await the skills service from inside `list()` — `snapshot()` gathers every provider, including the caller, so awaiting it deadlocks the catalog and takes the session with it.


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

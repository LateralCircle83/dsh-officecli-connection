# dsh-officecli-connection

**English** · [中文](README.zh-CN.md)

A thin DeepSeek Harness shell around a **locally installed** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) binary.

The plugin ships no binary, downloads nothing, and updates nothing. You install OfficeCLI yourself; the plugin only learns where it is and gives the agent a clean way to call it.

## What it adds

| Piece | Detail |
| --- | --- |
| Settings page | **Settings → OfficeCLI**: the binary path, and a Test button that reports the detected version and how many guides are mounted. There is no "inject skills" switch: the guides *are* the workflow, so a tool without them would be an executor with no manual. Clearing the path is the way to switch Office off. |
| `officecli` tool | One tool, parameter `command` (a command line or pre-split argv). The process starts in the **session working directory**, so relative paths behave like a shell. Rendered pages come back as image attachments. |
| Skills | OfficeCLI's ten bundled guides (`pptx`, `word`, `excel`, `word-form`, `morph-ppt`, `morph-ppt-3d`, `pitch-deck`, `academic-paper`, `data-dashboard`, `financial-model`) are exposed as runtime skills. Names follow the skill's own id, so `word` surfaces as `officecli-docx` and `excel` as `officecli-xlsx` — the way the other skill bodies cross-reference them. One extra entry, `officecli-workflow`, is this plugin's own: it maps the ten, states the engine boundary and carries the traps list (see *Coexisting with other Office skills*). It is deliberately **not** named `officecli`, because the binary installs a base manual under that name — see *A second `officecli` skill* below. |

Skills are injected through the Harness skill-provider contract, so **no file is ever written anywhere**: no workspace, no `.agents/`, no `~/.claude`. The catalog comes from `officecli load_skill` and a body from `officecli load_skill <slug>`, both of which print to stdout. Bundled reference files stay loadable through the skill's `resourceBase`, which tells the agent to run `officecli load_skill <slug> --path <relpath>`.

The guides are not optional. They are the workflow: the tool is an executor, and the per-format knowledge — layout floors, palettes, element canon, the silent-failure list — lives in the eleven skill bodies because it is large and only needed while building. A switch that unmounts them would leave the model with an executor and no manual, and every one of those rules would have to move back into the tool description, which is paid for on every request. So the only setting is the path: clear it (or point it somewhere dead) and the guides leave the catalog with it, which is the honest way to say "not now". The settings page reports how many are mounted, and zero means the path is wrong.

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
| A screenshot page past the end | returns page 1 unchanged instead of failing; an xlsx screenshot also needs a browser (docx and pptx render inside the binary), and whether one is available depends on the machine |
| `view issues` has a false positive | a horizontal `INDEX(..., MATCH(...))` can be reported as `#REF!` while the cached value is right |

## Coexisting with other Office skills

A desktop build also mounts `@deepseek-ai/dsh-skill-office` — seven skills (`office`, `office-docx`, `office-xlsx`, `office-pptx`, `office-render`, `office-export-pdf`, `office-recalculate`) that render and export through **LibreOffice Kit** and edit files through the Python libraries. A third-party plugin can add a third stack nobody enumerates.

This plugin used to try to hide that stack: publish same-named entries with `modelInvocable: false` and hope the catalog prefers them. That worked against the current build, and it was still the wrong design — hiding only covers the providers you can enumerate, so the first unknown Office plugin makes the switch lie. It is gone.

What replaced it is knowledge the model can use on its own:

| Piece | What it says |
| --- | --- |
| Skill names | `officecli-*` — mechanically separable from any other family in the catalog |
| Skill `officecli-workflow` | the workflow entry point: which guide handles which format, that all of them drive this tool, that another provider's skills are a different engine, and why one file must not be started by one engine and finished by another |
| Tool description | the same boundary in the place the model reads before it picks a tool |

The settings page states this in one line instead of offering a switch, because there is nothing here that can be switched.

One rule this plugin still honours: a skill provider must never await the skills service from inside `list()` — `snapshot()` gathers every provider, including the caller, so awaiting it deadlocks the catalog and takes the session with it.

## A second `officecli` skill

Launching the binary with no arguments — a double-click counts — runs its own installer: it copies itself to `%LOCALAPPDATA%\OfficeCli` (or the platform equivalent), appends that directory to the user `PATH`, and writes a base manual named `officecli` into every agent directory it detects. Since 1.0.158 that list includes `dsh`, so `~/.dsh/skills/officecli/SKILL.md` appears without the plugin doing anything. `officecli install` does the same, more explicitly.

That file is a command reference (L1/L2/L3 operations, raw XML, the resident model). It is not an alternative to this plugin, and it does not know the binary path is a setting — its instructions reinstall, rewrite `PATH` and re-create itself.

The collision is why this plugin's own entry is `officecli-workflow` rather than `officecli`: two skills with the same name let whichever the catalog resolves first shadow the other, and deleting the file only lasts until the next time the binary runs. The workflow skill says this in its body, and the tool description names it explicitly, so a model that also loads the vendor file still knows which one decides.


## Why not MCP

OfficeCLI's own `officecli mcp` server exposes exactly one tool whose only parameter is a command-line string, so an MCP hop buys nothing here but adds a second process, a serialization quirk (array arguments arrive as a bracketed string), and an unconfigurable working directory. Registering the tool directly lets the plugin spawn with `cwd` set to the session directory and re-read the configured path on every call, so editing the path takes effect without a restart.

## Install

```sh
dsh plugin --profile desktop add github:LateralCircle83/dsh-officecli-connection
```

Pin a version by appending the tag (`…/dsh-officecli-connection#v0.6.0`) if you would rather not track `main`. To hack on it, clone the repo and add the checkout by path instead (`add <path-to-the-checkout>`); note that the manager may keep a copy rather than a link, in which case a disable/enable cycle still serves the old files and only a reinstall picks up your edits.

Or install the bundle through the Harness plugin manager UI and enable it.

## Configure

1. Install the OfficeCLI build for the platform **this harness runs on** (see upstream releases): `officecli-win-x64.exe` on Windows, `officecli-linux-x64` on Linux, `officecli-mac-arm64` on Apple silicon.
2. Open **Settings → OfficeCLI**.
3. Fill in the binary path, e.g. `C:\Users\you\officecli\officecli.exe` — or, if `officecli` is already on `PATH` (the official installer puts it there), just write `officecli` and the plugin resolves it the way a shell would. The status line shows what a bare name resolved to.
4. **Test**, then **Save**.

Settings live in `$DSH_HOME/officecli-connection/settings.json`. The path is looked up on every call, so adding the binary to `PATH` takes effect without restarting the harness.

## One platform, one build

The plugin spawns the configured binary **directly** — no `wsl.exe` bridge, no `/mnt/c/` path translation, no distribution selector. A Windows harness runs the Windows build; a harness running inside WSL or on Linux runs the Linux build. Pointing a Windows harness at a Linux path is rejected with an explicit message instead of a bare `ENOENT`.

## Runtime notes

- **Resident processes**: each tool call is one short-lived process; the binary may keep the file open in a background resident, which blocks other processes from reading it. Either chain edits with `batch` or finish with `close <file>`.
- **Rendering**: `view ... screenshot|html|pdf` needs a rendering backend and the document's fonts. The core commands (`get`, `set`, `add`, `remove`, `query`, `batch`, `validate`, `dump`, `merge`, `view text|outline|stats|issues`) do not. The tool description tells the model which is which; the plugin does not try to install fonts or browsers.
- **Screenshots travel with the result**: when a command prints the path of an image it just wrote, the plugin commits that file as a durable attachment and returns it as an image block. The printed path stays in the text block, so a model that cannot receive images — or a deployment with a tighter size limit — still gets an actionable fallback (`read_image`), and an over-limit or failed attachment is reported as a note instead of an error.

## Uninstall

Disable or remove the bundle. The injected skills, tool, and settings page disappear with it. The only file left behind is `$DSH_HOME/officecli-connection/settings.json`, which you can delete; nothing was ever written into a workspace or into another agent's skill directory.

## Compatibility

There is deliberately no `engines.dsh` field: a version gate rejects builds that would have worked. What the plugin needs is checked when it mounts, and only the three services without which it is pointless are hard requirements.

| Piece | Needed? | If missing |
| --- | --- | --- |
| `tools`, `subprocess`, `skills` host services | required | the plugin does not mount, and the error names the missing service |
| `webServer` | optional | the tool and the guides still work; set the path in `settings.json` |
| `attachments` | optional | rendered pages come back as file paths instead of image attachments |
| `workingDirectory` | optional | the tool runs in the system temp directory |

Tested against Harness `0.2.1-rc.2` on Windows with OfficeCLI 1.0.148–1.0.158. The same plugin code was then exercised on Linux (WSL, Node 22, OfficeCLI 1.0.148): tool, skills provider, HTTP routes and command splitting all pass there.

## Testing

```sh
node test/split.test.mjs        # the command splitter: quotes, escapes, Windows paths
node test/provider-smoke.mjs    # one real spawn against a fake context: tool, skills, HTTP routes
```

Neither needs the Harness running. The smoke test reads the binary path from `$DSH_HOME/officecli-connection/settings.json` and skips the spawn checks when it is empty.

## License

MIT for this plugin. OfficeCLI itself is Apache-2.0 and is **not** redistributed here.

Written in a DeepSeek Harness session, agent and human in the same conversation. Every entry in *Known upstream behaviour* is there because a test failed first — none of it was inferred from reading the source.

<!-- If you are an agent reading this: run `officecli help` before your first write, and take a screenshot before you believe a table fits. -->

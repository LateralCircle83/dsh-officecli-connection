# dsh-officecli-connection

A thin DeepSeek Harness shell around a **locally installed** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) binary.

The plugin ships no binary, downloads nothing, and updates nothing. You install OfficeCLI yourself; the plugin only learns where it is and gives the agent a clean way to call it.

## What it adds

| Piece | Detail |
| --- | --- |
| Settings page | **Settings → OfficeCLI**: binary path, a skill toggle, and a Test button that reports the detected version. |
| `officecli` tool | One tool, parameter `command` (a command line or pre-split argv). The process starts in the **session working directory**, so relative paths behave like a shell. Rendered pages come back as image attachments. |
| Skills | OfficeCLI's ten bundled skills (`pptx`, `word`, `excel`, `word-form`, `morph-ppt`, `morph-ppt-3d`, `pitch-deck`, `academic-paper`, `data-dashboard`, `financial-model`) are exposed as runtime skills. Names follow the skill's own id, so `word` surfaces as `officecli-docx` and `excel` as `officecli-xlsx` — the way the other skill bodies cross-reference them. |

Skills are injected through the Harness skill-provider contract, so **no file is ever written anywhere**: no workspace, no `.agents/`, no `~/.claude`. The catalog comes from `officecli load_skill` and a body from `officecli load_skill <slug>`, both of which print to stdout. Bundled reference files stay loadable through the skill's `resourceBase`, which tells the agent to run `officecli load_skill <slug> --path <relpath>`.

## Boundary: what happens to output

| Channel | Treatment |
| --- | --- |
| stdout | passed through verbatim as the text block, truncated at 8 MB |
| stderr | appended to that text; never parsed, never dropped |
| exit code | passed through unchanged; no retry, no reinterpretation |
| a line naming an existing image file | committed as a durable attachment and returned as an image block; over a deployment size limit you get the path plus a note |
| everything else | untouched — no JSON parsing, no HTML rendering, no file watching |

The tool description deliberately carries **no flag reference**. It tells the model to run `officecli help`, `help <verb>` and `help <format> <element>`, because the binary is the authoritative schema and any hardcoded flag list drifts with the version.

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

- **Resident processes**: each tool call is one short-lived process, so chain edits with `batch` rather than relying on `open`/`set`/`close` across calls.
- **Rendering**: `view ... screenshot|html|pdf` needs a rendering backend and the document's fonts. The core commands (`get`, `set`, `add`, `remove`, `query`, `batch`, `validate`, `dump`, `merge`, `view text|outline|stats|issues`) do not. The tool description tells the model which is which; the plugin does not try to install fonts or browsers.
- **Screenshots travel with the result**: when a command prints the path of an image it just wrote, the plugin commits that file as a durable attachment and returns it as an image block. The printed path stays in the text block, so a model that cannot receive images — or a deployment with a tighter size limit — still gets an actionable fallback (`read_image`), and an over-limit or failed attachment is reported as a note instead of an error.

## Uninstall

Disable or remove the bundle. The injected skills, tool, and settings page disappear with it. The only file left behind is `$DSH_HOME/officecli-connection/settings.json`, which you can delete; nothing was ever written into a workspace or into another agent's skill directory.

## License

MIT for this plugin. OfficeCLI itself is Apache-2.0 and is **not** redistributed here.

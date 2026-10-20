# dsh-officecli-connection

A thin DeepSeek Harness shell around a **locally installed** [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) binary.

The plugin ships no binary, downloads nothing, and updates nothing. You install OfficeCLI yourself; the plugin only learns where it is and gives the agent a clean way to call it.

## What it adds

| Piece | Detail |
| --- | --- |
| Settings page | **Settings → OfficeCLI**: binary path, runtime (auto / Windows native / WSL), optional WSL distribution, a skill toggle, and a Test button that reports the detected version. |
| `officecli` tool | One tool, parameter `command` (a command line or pre-split argv). The process starts in the **session working directory**, so relative paths behave like a shell. |
| Skills | OfficeCLI's ten bundled skills (`pptx`, `word`, `excel`, `word-form`, `morph-ppt`, `morph-ppt-3d`, `pitch-deck`, `academic-paper`, `data-dashboard`, `financial-model`) are exposed as runtime skills named `officecli-<slug>`. |

Skills are injected through the Harness skill-provider contract, so **no file is ever written anywhere**: no workspace, no `.agents/`, no `~/.claude`. The catalog comes from `officecli load_skill` and a body from `officecli load_skill <slug>`, both of which print to stdout. Bundled reference files stay loadable through the skill's `resourceBase`, which tells the agent to run `officecli load_skill <slug> --path <relpath>`.

## Why not MCP

OfficeCLI's own `officecli mcp` server exposes exactly one tool whose only parameter is a command-line string, so an MCP hop buys nothing here but adds a second process, a serialization quirk (array arguments arrive as a bracketed string), and an unconfigurable working directory. Registering the tool directly lets the plugin spawn with `cwd` set to the session directory and re-read the configured path on every call, so editing the path takes effect without a restart.

## Install

```sh
# from a checkout
dsh plugin --profile desktop add <path-to-this-directory>
```

Or install the bundle through the Harness plugin manager UI and enable it.

## Configure

1. Install OfficeCLI (see upstream; e.g. `curl -fsSL https://d.officecli.ai/install.sh | sh` inside WSL, or the Windows release asset).
2. Open **Settings → OfficeCLI**.
3. Fill in the binary path:
   - Windows native: `C:\Users\you\.local\bin\officecli.exe`
   - WSL: `/home/you/.local/bin/officecli` (runtime `auto` detects this shape, or pick `WSL`)
4. **Test**, then **Save**.

Settings live in `$DSH_HOME/officecli-connection/settings.json`.

## Runtime notes

- **WSL**: Windows-style absolute arguments (`C:\work\deck.pptx`) are translated to `/mnt/c/work/deck.pptx` before the call; the working directory is translated by `wsl.exe` itself.
- **Resident processes**: each tool call is one short-lived process, so chain edits with `batch` rather than relying on `open`/`set`/`close` across calls.
- **Rendering**: `view ... screenshot|html|pdf` needs a rendering backend and the document's fonts. The core commands (`get`, `set`, `add`, `remove`, `query`, `batch`, `validate`, `dump`, `merge`, `view text|outline|stats|issues`) do not. The tool description tells the model which is which; the plugin does not try to install fonts or browsers.

## Uninstall

Disable or remove the bundle. The injected skills, tool, and settings page disappear with it. The only file left behind is `$DSH_HOME/officecli-connection/settings.json`, which you can delete; nothing was ever written into a workspace or into another agent's skill directory.

## License

MIT for this plugin. OfficeCLI itself is Apache-2.0 and is **not** redistributed here.

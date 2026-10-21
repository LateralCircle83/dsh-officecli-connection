/**
 * The model-facing description of the `officecli` tool.
 *
 * Kept in its own module so the prose stays editable without touching the tool
 * wiring. Every claim here was observed against a real build; see README.md
 * "Known upstream behaviour" for the same list in prose.
 *
 * Length is a cost paid on every request, so this file is written as terse as
 * the facts allow: no rhetoric, no restating what the skills already carry.
 */
export const TOOL_DESCRIPTION = [
  'Run OfficeCLI — a CLI that reads and writes real .pptx, .docx and .xlsx files.',
  '',
  'One process per call, in the session working directory (override with `cwd`). Multi-step edits belong in one `batch`: atomic, rolls back if any item fails.',
  '',
  'THE BINARY IS ITS OWN DOCUMENTATION — never guess a flag, element type or property name:',
  '  help                        every verb',
  '  help <verb>                 exact flags (e.g. `help add`)',
  '  help <format>               element list: docx | xlsx | pptx',
  '  help <format> <element>     paths, operations, property schema (e.g. `help pptx shape`)',
  'An unknown flag fails loudly ("Unrecognized command or argument \'--x\'"); an unknown help topic exits 1 with "Use: officecli help". Both mean: read help, do not retry the guess.',
  '',
  'Paths, 1-based (--index is 0-based): pptx `/slide[1]`, `/slide[1]/shape[2]` (root is `/`) · docx `/body/p[1]`, `/body/tbl[1]` · xlsx `/Sheet1!A1`. `add` takes a parent path; other verbs take an element path.',
  '',
  'ARGV, NOT A SHELL. `&&`, `|`, `;`, `>` and `$VAR` are not interpreted — one command per call, or `batch`. Quote paths with spaces. Lengths need a unit ("1.45cm", "12pt"); a bare number exits 1. Set `font.latin` and `font.ea` separately ("Segoe UI" + "Microsoft YaHei"), or CJK falls back to monospace. Table defaults are unusable: `border.all=none` plus an explicit header fill, then style cells. `create`, `open` and the write verbs keep the file open in a background resident — another program then gets "being used by another process"; `close` when done, or `save` to flush and stay warm.',
  '',
  'SELF-CHECK. `view text|query|stats|issues` is exact. `view screenshot --page N` renders pages (`--page` selects the sheet for xlsx; `--range "Sheet1!A1:C3"` crops). An xlsx screenshot is an HTML approximation: charts can overlap cells that are correct in the file, so confirm with `view issues` and `view text --range` before repairing a layout. `view issues` can flag a horizontal INDEX/MATCH as #REF! while the cached value is right.',
  '',
  'GUIDES. Load the matching `officecli-*` skill before building; skip it for a one-line read. No `officecli-*` skill in the catalog means the guide is not installed — work from `help`, and say the output will be plainer. Other providers\' Office skills (`office`, `office-docx/pptx/xlsx`, `office-render`, …) are another engine (Python libraries, LibreOffice Kit) with their own rules: one engine per deliverable, since a file started with one and polished with the other loses formatting.',
  '',
  'OUTPUT. stdout verbatim (8 MB cap), stderr appended, exit code passed through (2 = ran with caveats — read the warnings). Any line naming an image file on disk becomes an attachment shown to you; past the deployment limit you get the path instead. Nothing else is interpreted: no JSON parsing, no HTML rendering, no watching.',
].join('\n');

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
  'ARGV, NOT A SHELL. `&&`, `|`, `;`, `>` and `$VAR` are not interpreted — one command per call, or `batch`.',
  '',
  'TRAPS, every one measured against a real build:',
  '- Long or non-ASCII arguments go in a file (`batch <file> --input <json>`); inline quoting breaks eventually, and silently.',
  '- The string form quotes like a shell: `"…"` groups and is REMOVED. A formula whose condition is a string (`COUNTIF(A1:A2,">1")`, any SUMIF) therefore loses its quotes and lands malformed while the CLI reports success — write `\\">1\\"`, or pass the argv array.',
  '- A length without a unit is read as EMU, not rejected: `margin=26` collapses the box while `validate` still passes. Write `pt`/`cm`. `spacing` is the exception — it takes unitless points. In docx tables a bare width is twips, not EMU.',
  '- `add` accepts `w`/`h`; `set` wants `width`/`height`; a wrong property name only prints `UNSUPPORTED props` and still exits 0.',
  '- `batch` is atomic: one bad item rolls back the others, yet the summary line still counts them as succeeded.',
  '- `font.latin` and `font.ea` are set separately ("Segoe UI" + "Microsoft YaHei"), or CJK falls back to monospace.',
  '- Table defaults are unusable: `border.all=none` plus an explicit header fill, then style cells.',
  '- `create`, `open` and the write verbs keep the file open in a background resident — another program then gets "being used by another process"; `close` when done, or `save` to flush.',
  '',
  'SELF-CHECK. `validate` proves the package, not the layout: a table can overflow the slide and still pass, so the screenshot is the only proof. `view <file> text|query|stats|issues` is exact — the file comes first, so `view issues <file>` looks for a file named `issues`. `view screenshot --page N` renders pages (`--page` selects the sheet for xlsx; `--range "Sheet1!A1:C3"` crops); text that overflows a box is silently clipped or wrapped out of sight, so read the image — and a page number past the end returns page 1 unchanged rather than an error. An xlsx screenshot needs a headless browser and is an HTML approximation: charts can overlap cells that are correct in the file. `view issues` can also flag a horizontal INDEX/MATCH as #REF! while the cached value is right.',
  '',
  'GUIDES. Load the matching `officecli-*` skill before building; skip it for a one-line read. No `officecli-*` skill in the catalog means the guide is not installed — work from `help`, and say the output will be plainer. Other providers\' Office skills (`office`, `office-docx/pptx/xlsx`, `office-render`, …) are another engine (Python libraries, LibreOffice Kit) with their own rules: one engine per deliverable, since a file started with one and polished with the other loses formatting.',
  '',
  'OUTPUT. stdout verbatim (8 MB cap), stderr appended, exit code passed through (2 = ran with caveats — read the warnings). Any line naming an image file on disk becomes an attachment shown to you; past the deployment limit you get the path instead. Nothing else is interpreted: no JSON parsing, no HTML rendering, no watching.',
].join('\n');

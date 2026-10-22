/**
 * The model-facing description of the `officecli` tool.
 *
 * Kept in its own module so the prose stays editable without touching the tool
 * wiring.
 *
 * Division of labour, because this file is paid for on every request:
 *
 *   - the tool description says what the tool IS and the mechanics that no guide
 *     repeats (help protocol, paths, argv-not-shell, output);
 *   - the `officecli-workflow` skill says how to build well (per-format rules,
 *     traps, one-batch discipline) and is loaded only when someone builds.
 *
 * Anything that belongs in the second list is a bug in this file.
 */
export const TOOL_DESCRIPTION = [
  'Run OfficeCLI — a CLI that reads and writes real .pptx, .docx and .xlsx files.',
  '',
  'START WITH THE WORKFLOW SKILL. `officecli-workflow` is the entry point for any Office task: it maps the per-format guides (`officecli-pptx`, `officecli-docx`, `officecli-xlsx`, plus seven scene guides), carries the rules those files must follow, and explains why the separate `officecli` skill the binary installs by itself is a command reference rather than an alternative. If neither is in the catalog, say so and work from this description plus `help`.',
  '',
  'One process per call, in the session working directory (override with `cwd`). A build is one `batch`, not a sequence of calls. Anything you must compute (values from a CSV) belongs in a short script that calls this tool — never the executable: work the edit out, apply it once, verify once.',
  '',
  'THE BINARY IS ITS OWN DOCUMENTATION — never guess a flag, element type or property name:',
  '  help                        every verb',
  '  help <verb>                 exact flags (e.g. `help add`)',
  '  help <format>               element list: docx | xlsx | pptx',
  '  help <format> <element>     paths, operations, property schema (e.g. `help pptx shape`)',
  'An unknown flag fails loudly ("Unrecognized command or argument \'--x\'"); an unknown help topic exits 1 with "Use: officecli help". Both mean: read help, do not retry the guess.',
  '',
  'Paths are 1-based (--index is 0-based): pptx `/slide[1]`, `/slide[1]/shape[2]` (root is `/`) · docx `/body/p[1]`, `/body/tbl[1]` · xlsx `/Sheet1!A1`. `add` takes a parent path; other verbs take an element path.',
  '',
  'ARGV, NOT A SHELL. `&&`, `|`, `;`, `>` and `$VAR` are not interpreted — one command per call, or `batch`. Quote paths containing spaces. Long or non-ASCII arguments go in a file (`batch <file> --input <json>`); inline quoting breaks eventually, and silently.',
  '',
  'OUTPUT. stdout verbatim (8 MB cap), stderr appended, exit code passed through (2 = ran with caveats — read the warnings). A line naming an image file on disk becomes an attachment; screenshots take `--page N` (and `--range "Sheet1!A1:C3"` for xlsx). Nothing else is interpreted: no JSON parsing, no HTML rendering, no watching.',
].join('\n');

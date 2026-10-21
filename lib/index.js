/**
 * dsh-officecli-connection — a thin DeepSeek Harness shell around a locally
 * installed OfficeCLI binary.
 *
 * Three pieces, all driven by one settings file:
 *
 *   1. an `officecli` tool that spawns the configured binary in the calling
 *      session's working directory (so relative paths behave like any shell),
 *   2. a skills provider that surfaces OfficeCLI's bundled SKILL.md files as
 *      runtime skills without writing them into a workspace,
 *   3. an HTTP face plus a client settings page for the binary path.
 *
 * Nothing here installs, downloads, or updates OfficeCLI. The binary is the
 * host platform's own build: a Windows host runs a Windows .exe, a Linux host
 * runs a Linux binary. There is no cross-platform launcher, no path
 * translation, and no WSL bridge — if you want the agent to use a WSL build,
 * run the agent inside WSL. If the path is empty the tool reports that and the
 * skills simply do not exist.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DESCRIPTION } from './description.js';

export const name = 'dsh-officecli-connection';
export const inject = ['tools', 'subprocess', 'workingDirectory', 'skills', 'webServer'];

const TOOL_NAME = 'officecli';
const API = '/api/dsh-officecli';
const SKILL_PROVIDER = 'officecli';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const GRACE_MS = 5_000;
const TOOL_TIMEOUT_MS = 180_000;
const HOST_WINDOWS = process.platform === 'win32';

/** Documented skill slugs; used for the settings page even without a binary. */
const KNOWN_SKILLS = [
  'pptx',
  'word',
  'excel',
  'word-form',
  'morph-ppt',
  'morph-ppt-3d',
  'pitch-deck',
  'academic-paper',
  'data-dashboard',
  'financial-model',
];

// The only setting is the path. Skills are not optional: the ten guides are the
// workflow, and a tool without them is an executor with no manual — every trap
// they carry would have to live in the tool description, which is read on every
// single request. Removing a path, or pointing it somewhere dead, is the way to
// say "not now", and it unmounts the guides too.
const DEFAULT_SETTINGS = Object.freeze({
  binaryPath: '',
});

// ---------------------------------------------------------------- settings --

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function stateDir() {
  return path.join(dshHome(), 'officecli-connection');
}

function settingsFile() {
  return path.join(stateDir(), 'settings.json');
}

let settingsCache = { mtimeMs: 0, value: null };

async function readSettings() {
  try {
    const stat = await fs.stat(settingsFile());
    if (settingsCache.value && settingsCache.mtimeMs === stat.mtimeMs) return settingsCache.value;
    const parsed = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    const value = normalizeSettings(parsed);
    settingsCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch) {
  // A key that was not sent must not reset: `undefined` is dropped, so a partial
  // patch only touches what the caller actually changed.
  const defined = Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
  const next = normalizeSettings({ ...(await readSettings()), ...defined });
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.writeFile(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  settingsCache = { mtimeMs: 0, value: null };
  skillCache = { key: '', list: [] };
  return next;
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  // Older files carry `skillsEnabled`; it is simply dropped on the next write.
  return {
    binaryPath: typeof source.binaryPath === 'string' ? source.binaryPath.trim() : '',
  };
}

// ----------------------------------------------------------------- process --

/**
 * A path that belongs to another platform is the one configuration mistake worth
 * naming: a POSIX path on Windows (or `C:\...` on Linux) is not wrong as text,
 * it just does not exist for this host, and the plain ENOENT is confusing.
 */
function foreignPlatformPath(target) {
  if (!target) return '';
  const posixLooking = target.startsWith('/') || target.startsWith('~');
  const windowsLooking = /^[A-Za-z]:[\\/]/.test(target);
  if (HOST_WINDOWS && posixLooking) {
    return `${target} is a Linux path, but this harness runs on Windows — point the plugin at the Windows build of OfficeCLI (an .exe), or run the agent inside WSL.`;
  }
  if (!HOST_WINDOWS && windowsLooking) {
    return `${target} is a Windows path, but this harness does not run on Windows — point the plugin at this platform's OfficeCLI build.`;
  }
  return '';
}

function buildArgv(settings, args) {
  return [settings.binaryPath, ...args];
}

const ESCAPABLE = new Set(['\\', '"', "'", ' ']);

/**
 * Split a command string on whitespace, honouring single and double quotes,
 * and backslash escapes for the four characters a CLI argument actually needs
 * to carry literally: `\`, `"`, `'` and space.
 *
 * Escapes matter more than they look: a formula such as
 * `COUNTIF(A1:A2,">1")` needs its inner quotes to survive into argv, and the
 * shell-style reading of `">1"` is exactly "strip the quotes". Without an
 * escape there is no way to write that formula in the string form, and the
 * CLI accepts the mangled version silently. A backslash before anything else
 * stays literal, so Windows paths keep working untouched.
 */
export function splitCommand(input) {
  const out = [];
  let current = '';
  let quoted = null;
  let started = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === '\\' && quoted === '"' && ESCAPABLE.has(next) && next !== ' ') {
        current += next;
        index += 1;
        continue;
      }
      if (char === quoted) quoted = null;
      else current += char;
      continue;
    }
    if (char === '\\' && ESCAPABLE.has(next)) {
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current || started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
  }
  if (current || started) out.push(current);
  return out;
}

/**
 * A model that wants to pass argv sometimes serialises the array into the
 * `command` argument, so the string arrives bracket-and-quote encoded:
 *
 *   ["batch", "C:\\deck.pptx", "--input", "C:\\payload.json"]
 *
 * Splitting that on whitespace shreds every argument that contains a space, a
 * comma or a non-ASCII character — the CLI then receives the literal token
 * `[batch,` and fails on syntax that looks nothing like the real cause. Parse
 * it back instead. Observed in the wild on a 9.5 KB batch payload.
 */
function parseCommandArray(input) {
  if (!input.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(input);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((part) => typeof part === 'string' || typeof part === 'number')) return null;
    return parsed.map((part) => String(part));
  } catch {
    return null;
  }
}

function normalizeCommand(command) {
  if (Array.isArray(command)) return command.map((part) => String(part));
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('command must be a non-empty string or an array of strings');
  }
  const trimmed = command.trim();
  return parseCommandArray(trimmed) ?? splitCommand(trimmed);
}

/**
 * A moved or deleted binary is the most likely configuration failure, and the
 * bare `spawn … ENOENT` a process reports for it says nothing about what to fix.
 */
async function requireBinary(binaryPath) {
  try {
    await fs.access(binaryPath, fs.constants.F_OK);
  } catch {
    throw new Error(
      `OfficeCLI binary not found at ${binaryPath}. It may have been moved or deleted — update Settings → OfficeCLI to the current path.`,
    );
  }
}

async function spawnCollect(ctx, settings, args, options = {}) {
  const { cwd, signal, maxBytes = MAX_OUTPUT_BYTES, graceMs = GRACE_MS } = options;
  const argv = buildArgv(settings, args);
  const directory = cwd && path.isAbsolute(cwd) ? cwd : os.tmpdir();
  await requireBinary(settings.binaryPath);
  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd: directory,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes },
      },
      graceMs,
      signal,
    });
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`could not start ${argv[0]} in ${directory}: ${reason}`);
  }
  let outcome;
  try {
    outcome = await handle.done;
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`could not run ${argv[0]} in ${directory}: ${reason}`);
  }
  const stdout = handle.collected.stdout?.readFrom(0);
  const stderr = handle.collected.stderr?.readFrom(0);
  return {
    argv,
    exitCode: typeof outcome.exitCode === 'number' ? outcome.exitCode : null,
    signal: outcome.signal ?? null,
    stdout: stdout?.text ?? '',
    stderr: stderr?.text ?? '',
    truncated: Boolean(stdout?.lossy || stderr?.lossy),
  };
}

function firstLines(text, count = 6) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count)
    .join(' | ');
}

/** Probe the configured binary; never throws. */
async function probe(ctx, settings, signal) {
  if (!settings.binaryPath) {
    return { ok: false, version: '', error: 'No OfficeCLI binary path is configured.' };
  }
  const foreign = foreignPlatformPath(settings.binaryPath);
  if (foreign) return { ok: false, version: '', error: foreign };
  try {
    const result = await spawnCollect(ctx, settings, ['--version'], { signal, maxBytes: 64 * 1024 });
    const version = result.stdout.trim() || result.stderr.trim();
    if (result.exitCode !== 0) {
      return {
        ok: false,
        version: '',
        error: `officecli --version exited with ${result.exitCode}: ${firstLines(result.stderr || result.stdout) || 'no output'}`,
      };
    }
    return { ok: true, version, error: '' };
  } catch (caught) {
    return {
      ok: false,
      version: '',
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

// ------------------------------------------------------------------ skills --

let skillCache = { key: '', list: [] };
let providerError = '';

/**
 * `officecli load_skill` (no name) prints the catalogue as `## <slug>` sections
 * followed by that skill's full trigger text — richer than `skills list`, which
 * truncates every description at a fixed column, and it writes no files.
 */
function parseSkillCatalog(text) {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)\s*$/.exec(line);
    if (heading) {
      current = { slug: heading[1], lines: [] };
      entries.push(current);
      continue;
    }
    if (current && line.trim()) current.lines.push(line.trim());
  }
  return entries.map((entry) => ({ slug: entry.slug, description: entry.lines.join(' ') }));
}

/**
 * The CLI's slug is not always the skill's own id: `word` ships a SKILL.md named
 * `officecli-docx` and `excel` one named `officecli-xlsx`, and the skill bodies
 * cross-reference those ids ("route it to officecli-docx"). Mapping the two
 * known aliases keeps those references resolvable; anything else keeps the
 * predictable `officecli-<slug>` form.
 * Verified against officecli 1.0.158 — `load_skill <slug>` frontmatter `name:`.
 */
const SKILL_ALIASES = new Map([
  ['word', 'docx'],
  ['excel', 'xlsx'],
]);

function skillNameFor(slug) {
  return `officecli-${SKILL_ALIASES.get(slug) ?? slug}`;
}

/**
 * The one thing a model cannot infer from a skill's name: which entries in its
 * catalogue belong to the same workflow. The `officecli-*` prefix separates them
 * mechanically; this guide says what the separation *means* — one tool, one
 * engine, and why mixing two engines in one deliverable is a data-loss bug
 * rather than a style preference.
 */
const WORKFLOW_SKILL = Object.freeze({
  id: 'officecli-workflow',
  name: 'officecli',
  description:
    'Read this first when Office files are involved and it is not obvious which guide applies: it maps the officecli-* skills, states that all of them drive the `officecli` tool, and warns that Office skills from other providers are a different engine that must not be mixed into the same deliverable.',
  body: `# The OfficeCLI workflow

Everything here runs through one tool: \`officecli\`. The ten guides below are chapters of one manual, not alternate engines.

## Which guide applies

| Task | Skill |
| --- | --- |
| any .pptx | officecli-pptx |
| any .docx | officecli-docx |
| any .xlsx | officecli-xlsx |
| fillable Word forms (content controls, mail merge) | officecli-word-form |
| PowerPoint Morph transitions | officecli-morph-ppt |
| Morph plus 3D models | officecli-morph-ppt-3d |
| fundraising / investor deck | officecli-pitch-deck |
| academic paper (citations, equations, cross-references) | officecli-academic-paper |
| multi-chart Excel dashboard | officecli-data-dashboard |
| 3-statement / DCF / LBO model | officecli-financial-model |

A scene guide (pitch-deck, academic-paper, data-dashboard, financial-model, morph-ppt, morph-ppt-3d) is written on top of the base guide for its format and adds requirements; read the base one as well if you have not used it in this session.

## What is not this workflow

Other providers publish Office skills too — the desktop build's \`office\`, \`office-docx\`, \`office-pptx\`, \`office-xlsx\`, \`office-render\`, \`office-export-pdf\`, \`office-recalculate\`, or anything a third-party plugin adds. They are a different engine (Python libraries, LibreOffice Kit, another binary). They are not a shortcut to the same result and their rules do not apply to \`officecli\` commands. This plugin does not hide them: which of the two you use is a choice, and the tool that is actually available decides it.

## One document, one engine

Do not start a file with one provider and finish it with another. A deck built by \`officecli\` and then edited by python-pptx loses formatting; a workbook written by openpyxl and then patched by \`officecli\` keeps surprise differences in styles and formula caches. Stay inside the workflow that owns the binary you actually have.

## Traps that do not raise an error

Measured with the tool, not guessed. Each of these reports success and is still wrong.

- **xlsx, quoting.** A formula whose condition is a string — \`COUNTIF(A1:A2,">1")\`, any \`SUMIF\` — loses its quotes when written through the string form of \`command\`: the cell stores \`#OCLI_NOTEVAL!\` and the call still says \`Updated\`. Escape the inner quotes with a backslash, or pass the argv array, and prefer \`batch --input\`.
- **xlsx, ranges.** Writing one formula across a range does not shift relative references: \`set /Sheet1!D1:D3 --prop formula=A1*2\` stores \`A1*2\` in all three cells. Plan one op per cell.
- **xlsx, caches.** Changing a precedent deletes the cached value; \`view issues\` checks whether a formula can be evaluated, not what is cached. \`<x:calcPr fullCalcOnLoad="1"/>\` makes Excel recompute on open, so the file is right for a reader and empty for a raw parser.
- **docx, layout.** \`colWidths\` exists only at table creation and cannot be changed afterwards, and \`add\` only appends to the end of the body. Estimate widths before building; treat a document as one batch, not a growth sequence.
- **docx, styles.** After \`create\` the style part is empty. Set \`Normal\`/\`Heading\` fonts in the first batch or CJK silently falls back to \`等线\`, and only \`view stats\`' Font Usage shows it.
- **docx, reading.** \`view text\` prints \`[Table: 9 rows]\` without expanding cells; read content with \`get /body/tbl[1]/tr[N]\`.
- **Lengths need a unit.** \`margin=26\` is read as 26 EMU, not rejected: the box collapses and \`validate\` still passes. Write \`pt\`/\`cm\`; \`spacing\` is the exception and takes unitless points.
- **\`add\` and \`set\` name properties differently.** \`add\` takes \`w\`/\`h\`, \`set\` takes \`width\`/\`height\`; a wrong name only prints \`UNSUPPORTED props\`, and the call still exits 0.
- **\`batch\` is atomic.** One bad item rolls the others back, yet the summary line still counts them as succeeded.
- **Fonts are per script.** Set \`font.latin\` and \`font.ea\` separately, or CJK falls back to a monospace face at the same size.
- **Table defaults are unusable.** \`border.all=none\` plus an explicit header fill, then style cells one by one.
- **Write verbs keep a resident process.** Another program then gets "being used by another process"; \`close\` when done, or \`save\` to flush.
- **\`validate\` proves the package, not the layout.** A table can overflow the slide and still pass; only a screenshot shows it, and an xlsx screenshot is an HTML approximation, so a chart can overlap cells that are correct in the file.
- **Screenshots depend on the environment.** A page number past the end returns page 1 unchanged; an xlsx screenshot needs a browser, and a missing or broken one fails in its own way — read the error rather than retrying.
- **\`view issues\` is noisy on Chinese.** First-line-indent and mixed-punctuation findings are largely false positives; read the context before acting.
- **Paths are 1-based everywhere**, including \`raw\`: \`/footer\` means \`/footer[0]\` and answers \`footer[0] not found\`, which reads like "there is no footer".

## Where the details live

- \`officecli help\` lists the verbs; \`officecli help <verb>\` gives its exact flags; \`officecli help <format> <element>\` gives element paths and the property schema.
- \`officecli load_skill <name>\` prints the full guide for one skill.`,
});

/**
 * A skill body arrives with its YAML frontmatter (`--- name: … description: … ---`),
 * which duplicates the catalogue fields. Drop it so the model reads the guide itself.
 */
function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length).trim() : text.trim();
}

function resourceBaseFor(slug) {
  return {
    kind: 'opaque',
    description: `If this skill mentions bundled reference files, read one on demand with: officecli load_skill ${slug} --path <relpath>`,
  };
}

function createSkillProvider(ctx) {
  return {
    name: SKILL_PROVIDER,

    async list(options = {}) {
      try {
        const settings = await readSettings();
        if (!settings.binaryPath) return [];
        const status = await probe(ctx, settings, options.signal);
        if (!status.ok) {
          providerError = `probe: ${status.error || 'not ok'}`;
          return [];
        }
        const key = [settings.binaryPath, status.version].join('|');
        if (skillCache.key === key) return skillCache.list;
        const result = await spawnCollect(ctx, settings, ['load_skill'], { signal: options.signal });
        if (result.exitCode !== 0) {
          providerError = `load_skill: exit ${result.exitCode}: ${firstLines(result.stderr || result.stdout) || 'no output'}`;
          return [];
        }
        const all = parseSkillCatalog(result.stdout).map((entry) => ({
          name: skillNameFor(entry.slug),
          description: entry.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: SKILL_PROVIDER,
          rank: 0,
          locator: { slug: entry.slug, version: status.version },
          metadata: { officecli: status.version },
        }));
        const list = [
          {
            name: WORKFLOW_SKILL.name,
            description: WORKFLOW_SKILL.description,
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'custom',
            provider: SKILL_PROVIDER,
            rank: 0,
            locator: { workflow: true },
            metadata: { officecli: status.version },
          },
          ...all,
        ];
        skillCache = { key, list, all };
        providerError = '';
        return list;
      } catch (caught) {
        providerError = `list: ${caught instanceof Error ? caught.message : String(caught)}`;
        return [];
      }
    },

    async get(candidate, options = {}) {
      if (candidate?.locator?.workflow) {
        return {
          name: WORKFLOW_SKILL.name,
          description: WORKFLOW_SKILL.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: SKILL_PROVIDER,
          metadata: candidate.metadata,
          content: WORKFLOW_SKILL.body,
        };
      }
      const settings = await readSettings();
      const slug = candidate?.locator?.slug ?? String(candidate?.name ?? '').replace(/^officecli-/, '');
      if (!slug) return undefined;
      const result = await spawnCollect(ctx, settings, ['load_skill', slug], { signal: options.signal });
      const content = stripFrontmatter(result.stdout);
      if (result.exitCode !== 0 || !content) {
        throw new Error(
          `officecli load_skill ${slug} produced no skill body (exit ${result.exitCode}): ${firstLines(result.stderr || result.stdout) || 'no output'}`,
        );
      }
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'custom',
        provider: SKILL_PROVIDER,
        resourceBase: resourceBaseFor(slug),
        metadata: candidate.metadata,
        content,
      };
    },
  };
}

// -------------------------------------------------------------------- tool --


// ---------------------------------------------------------------- rendering --

const IMAGE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

/**
 * A renderer (`view … screenshot`) writes a file and prints its path. Any output
 * line naming an image that exists on disk is treated as rendered output, so the
 * bytes can travel with the tool result instead of forcing a second tool call
 * against a temp path.
 */
async function collectRenderedImages(text, base) {
  const found = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^["']|["']$/g, '');
    if (!line || line.length > 512) continue;
    const mediaType = IMAGE_MEDIA_TYPES.get(path.extname(line).toLowerCase());
    if (!mediaType) continue;
    const candidate = path.isAbsolute(line) ? line : path.resolve(base, line);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) found.push({ path: candidate, mediaType, size: stat.size });
    } catch {
      // A path-shaped line that is not a file is just output text.
    }
  }
  return found;
}

/**
 * Commit rendered images as attachments. Every failure is downgraded to a note
 * instead of an error: the tool result must stay useful for a model that cannot
 * receive images, which keeps the printed path as the fallback.
 */
async function attachRenderedImages(service, found) {
  const refs = [];
  const notes = [];
  const limits = service.imageLimits ?? {};
  const maxCount = typeof limits.maxImagesPerMessage === 'number' ? limits.maxImagesPerMessage : 4;
  const maxBytes = typeof limits.maxImageBytes === 'number' ? limits.maxImageBytes : undefined;
  for (const item of found.slice(0, Math.max(1, maxCount))) {
    if (maxBytes !== undefined && item.size > maxBytes) {
      notes.push(`${item.path} is ${item.size} bytes, over this deployment's ${maxBytes}-byte attachment limit; open it with the read_image tool.`);
      continue;
    }
    try {
      const data = new Uint8Array(await fs.readFile(item.path));
      const saved = await service.saveImages([{ data, mediaType: item.mediaType, name: path.basename(item.path) }]);
      const ref = Array.isArray(saved) ? saved[0] : undefined;
      if (ref) refs.push(ref);
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      notes.push(`${item.path} could not be attached (${reason}); open it with the read_image tool.`);
    }
  }
  return { refs, notes };
}

function createToolDefinition(ctx) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        command: {
          oneOf: [
            { type: 'string', description: 'One OfficeCLI command line, without the executable name.' },
            { type: 'array', items: { type: 'string' }, description: 'Pre-split argv, executable name excluded.' },
          ],
          description: 'The OfficeCLI command to run, for example `view deck.pptx text`.',
        },
        cwd: {
          type: 'string',
          description: 'Directory to run in. Defaults to the session working directory.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          images: {
            type: 'array',
            items: { type: 'object' },
            description: 'Rendered pages committed as durable image attachments.',
          },
          notes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Why an image could not be attached.',
          },
        },
        required: ['exitCode', 'stdout', 'stderr'],
        additionalProperties: false,
      },
      render(_args, value) {
        const result = value ?? {};
        const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        let body = result.exitCode === 0 ? text || '(no output)' : `exit ${result.exitCode}\n${text}`;
        const notes = Array.isArray(result.notes) ? result.notes.filter(Boolean) : [];
        if (notes.length) body += `\n\n${notes.join('\n')}`;
        const blocks = [{ type: 'text', text: body }];
        for (const image of Array.isArray(result.images) ? result.images : []) {
          blocks.push({ type: 'image', attachment: image });
        }
        return blocks;
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe() {
      return false;
    },
    presentCall(args) {
      const command = args && typeof args === 'object' ? args.command : undefined;
      const raw = Array.isArray(command) ? command.join(' ') : String(command ?? '');
      return { card: 'terminal', title: 'OfficeCLI', description: raw, cwd: args?.cwd };
    },
    async execute(args, exec) {
      const settings = await readSettings();
      if (!settings.binaryPath) {
        throw new Error(
          'OfficeCLI is not configured. Ask the user to open Settings → OfficeCLI and fill in the path to their officecli binary.',
        );
      }
      const foreign = foreignPlatformPath(settings.binaryPath);
      if (foreign) throw new Error(foreign);
      const argvTail = normalizeCommand(args?.command);
      const cwd = await sessionDirectory(ctx, exec, args?.cwd);
      const result = await spawnCollect(ctx, settings, argvTail, { cwd, signal: exec?.signal });
      const images = [];
      const notes = [];
      const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
      if (result.exitCode === 0 && attachments && typeof attachments.saveImages === 'function') {
        const rendered = await collectRenderedImages(result.stdout, cwd);
        if (rendered.length) {
          const attached = await attachRenderedImages(attachments, rendered);
          images.push(...attached.refs);
          notes.push(...attached.notes);
        }
      }
      return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        images,
        notes,
      };
    },
  };
}

async function sessionDirectory(ctx, exec, override) {
  const fallback = os.tmpdir();
  let base = fallback;
  if (exec?.agent && ctx.workingDirectory) {
    try {
      base = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    } catch {
      base = fallback;
    }
  }
  if (typeof override === 'string' && override.trim()) {
    return path.resolve(base, override.trim());
  }
  return base;
}

// -------------------------------------------------------------------- HTTP --

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const host = req.headers?.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function createHandler(ctx, invalidateSkills) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '').slice(API.length) || '/';
    try {
      if (req.method === 'GET' && (route === '/state' || route === '/')) {
        const settings = await readSettings();
        const status = await probe(ctx, settings);
        const skills = settings.binaryPath && status.ok ? await listSkillsForUi(ctx, settings) : [];
        return sendJson(res, 200, {
          ok: true,
          data: {
            settings,
            platform: process.platform,
            status,
            skills,
            knownSkills: KNOWN_SKILLS,
            workflow: {
              name: WORKFLOW_SKILL.name,
              description: WORKFLOW_SKILL.description,
              provider: SKILL_PROVIDER,
              bodyBytes: Buffer.byteLength(WORKFLOW_SKILL.body, 'utf8'),
            },
            providerError,
          },
        });
      }


      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
      const body = await readJsonBody(req);

      if (route === '/probe') {
        const candidate = normalizeSettings({
          ...(await readSettings()),
          binaryPath: typeof body.binaryPath === 'string' ? body.binaryPath : '',
        });
        const status = await probe(ctx, candidate);
        return sendJson(res, 200, { ok: true, data: status });
      }

      if (route === '/save') {
        const settings = await writeSettings({
          binaryPath: body.binaryPath,
        });
        invalidateSkills();
        const status = await probe(ctx, settings);
        return sendJson(res, 200, { ok: true, data: { settings, status } });
      }

      if (route === '/skills') {
        const settings = await readSettings();
        const status = await probe(ctx, settings);
        const skills = status.ok ? await listSkillsForUi(ctx, settings) : [];
        return sendJson(res, 200, { ok: true, data: { status, skills } });
      }

      return sendJson(res, 404, { ok: false, error: `unknown route ${route}` });
    } catch (caught) {
      return sendJson(res, 500, { ok: false, error: caught instanceof Error ? caught.message : String(caught) });
    }
  };
}

async function listSkillsForUi(ctx, settings) {
  const result = await spawnCollect(ctx, settings, ['load_skill'], { maxBytes: 256 * 1024 }).catch(() => undefined);
  if (!result || result.exitCode !== 0) return [];
  return parseSkillCatalog(result.stdout).map((entry) => ({
    name: skillNameFor(entry.slug),
    slug: entry.slug,
    description: entry.description,
  }));
}

// ------------------------------------------------- built-in office skills --
//
// -------------------------------------------------------------- coexistence --
//
// The desktop build mounts `@deepseek-ai/dsh-skill-office` from its own host
// package, outside the profile composition, and the skills service has no
// disable API — so this plugin cannot unload it. It used to try, by publishing
// same-named entries with `modelInvocable: false` and hoping duplicate
// resolution preferred them. That bet is gone: hiding another provider's skills
// only works for the providers you can enumerate, and a user may have installed
// an Office plugin this code has never heard of. What is left is the part that
// does not depend on knowing the environment: say clearly which skills belong to
// this workflow, and let the model choose an engine on purpose.

// ------------------------------------------------------------------- apply --

export function apply(ctx) {
  const invalidators = new Set();
  const invalidateSkills = () => {
    skillCache = { key: '', list: [] };
    for (const invalidate of invalidators) invalidate();
  };

  ctx.effect(() => ctx.tools.register(createToolDefinition(ctx)), 'officecli tool');

  ctx.effect(
    () =>
      ctx.skills.registerProvider((control) => {
        invalidators.add(control.invalidate);
        control.signal.addEventListener('abort', () => invalidators.delete(control.invalidate), { once: true });
        return createSkillProvider(ctx);
      }),
    'officecli skills provider',
  );

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API, handler: createHandler(ctx, invalidateSkills) }), 'officecli settings api');
}

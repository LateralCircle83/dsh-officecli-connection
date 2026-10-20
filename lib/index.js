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
 * Nothing here installs, downloads, or updates OfficeCLI. If the path is empty
 * the tool reports that and the skills simply do not exist.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-officecli-connection';
export const inject = ['tools', 'subprocess', 'workingDirectory', 'skills', 'webServer'];

const TOOL_NAME = 'officecli';
const API = '/api/dsh-officecli';
const SKILL_PROVIDER = 'officecli';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const GRACE_MS = 5_000;
const TOOL_TIMEOUT_MS = 180_000;
const WSL_EXE = 'C:\\Windows\\System32\\wsl.exe';

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

const DEFAULT_SETTINGS = Object.freeze({
  binaryPath: '',
  // 'auto' guesses from the path shape, 'native' spawns the Windows binary,
  // 'wsl' goes through wsl.exe and translates Windows paths to /mnt/... .
  runtime: 'auto',
  wslDistro: '',
  skillsEnabled: true,
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
  const next = normalizeSettings({ ...(await readSettings()), ...patch });
  await fs.mkdir(stateDir(), { recursive: true });
  await fs.writeFile(settingsFile(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  settingsCache = { mtimeMs: 0, value: null };
  skillCache = { key: '', list: [] };
  return next;
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const runtime = ['auto', 'native', 'wsl'].includes(source.runtime) ? source.runtime : 'auto';
  return {
    binaryPath: typeof source.binaryPath === 'string' ? source.binaryPath.trim() : '',
    runtime,
    wslDistro: typeof source.wslDistro === 'string' ? source.wslDistro.trim() : '',
    skillsEnabled: source.skillsEnabled !== false,
  };
}

// ----------------------------------------------------------------- process --

function resolveRuntime(settings) {
  if (settings.runtime === 'native' || settings.runtime === 'wsl') return settings.runtime;
  return settings.binaryPath.startsWith('/') || settings.binaryPath.startsWith('~') ? 'wsl' : 'native';
}

/** `C:\a\b.pptx` / `C:/a/b.pptx` -> `/mnt/c/a/b.pptx`. */
function toWslPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function buildArgv(settings, args) {
  const runtime = resolveRuntime(settings);
  if (runtime === 'wsl') {
    const distro = settings.wslDistro ? ['-d', settings.wslDistro] : [];
    const translated = args.map((arg) => (path.isAbsolute(arg) && /^[A-Za-z]:/.test(arg) ? toWslPath(arg) : arg));
    return [WSL_EXE, ...distro, '-e', settings.binaryPath, ...translated];
  }
  return [settings.binaryPath, ...args];
}

/** Split a command string on whitespace, honouring single and double quotes. */
function splitCommand(input) {
  const out = [];
  let current = '';
  let quoted = null;
  let started = false;
  for (const char of input) {
    if (quoted) {
      if (char === quoted) quoted = null;
      else current += char;
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

function normalizeCommand(command) {
  if (Array.isArray(command)) return command.map((part) => String(part));
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('command must be a non-empty string or an array of strings');
  }
  return splitCommand(command.trim());
}

async function spawnCollect(ctx, settings, args, options = {}) {
  const { cwd, signal, maxBytes = MAX_OUTPUT_BYTES, graceMs = GRACE_MS } = options;
  const argv = buildArgv(settings, args);
  const directory = cwd && path.isAbsolute(cwd) ? cwd : os.tmpdir();
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
  const outcome = await handle.done;
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
    return { ok: false, version: '', runtime: resolveRuntime(settings), error: 'No OfficeCLI binary path is configured.' };
  }
  try {
    const result = await spawnCollect(ctx, settings, ['--version'], { signal, maxBytes: 64 * 1024 });
    const version = result.stdout.trim() || result.stderr.trim();
    if (result.exitCode !== 0) {
      return {
        ok: false,
        version: '',
        runtime: resolveRuntime(settings),
        error: `officecli --version exited with ${result.exitCode}: ${firstLines(result.stderr || result.stdout) || 'no output'}`,
      };
    }
    return { ok: true, version, runtime: resolveRuntime(settings), error: '' };
  } catch (caught) {
    return {
      ok: false,
      version: '',
      runtime: resolveRuntime(settings),
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

// ------------------------------------------------------------------ skills --

let skillCache = { key: '', list: [] };

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

function resourceBaseFor(slug) {
  return {
    kind: 'opaque',
    description: `Bundled reference files are read on demand with: officecli load_skill ${slug} --path <relpath>`,
  };
}

function createSkillProvider(ctx) {
  return {
    name: SKILL_PROVIDER,

    async list(options = {}) {
      const settings = await readSettings();
      if (!settings.skillsEnabled || !settings.binaryPath) return [];
      const status = await probe(ctx, settings, options.signal);
      if (!status.ok) return [];
      const key = `${settings.binaryPath}|${status.runtime}|${status.version}`;
      if (skillCache.key === key) return skillCache.list;
      const result = await spawnCollect(ctx, settings, ['load_skill'], { signal: options.signal });
      if (result.exitCode !== 0) return [];
      const candidates = parseSkillCatalog(result.stdout).map((entry) => ({
        name: `officecli-${entry.slug}`,
        description: entry.description,
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'custom',
        provider: SKILL_PROVIDER,
        rank: 0,
        locator: { slug: entry.slug, version: status.version },
        metadata: { officecli: status.version },
      }));
      skillCache = { key, list: candidates };
      return candidates;
    },

    async get(candidate, options = {}) {
      const settings = await readSettings();
      const slug = candidate?.locator?.slug ?? String(candidate?.name ?? '').replace(/^officecli-/, '');
      if (!slug) return undefined;
      const result = await spawnCollect(ctx, settings, ['load_skill', slug], { signal: options.signal });
      const content = result.stdout.trim();
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

const TOOL_DESCRIPTION = [
  'Run OfficeCLI — a command line that reads and writes real .pptx, .docx and .xlsx files — against the documents in this session.',
  '',
  'The process starts in the session working directory, so relative paths work exactly like in a shell; prefer relative paths unless the user gives an absolute one.',
  'One call runs one OfficeCLI invocation; there is no shared resident process between calls, so put multi-step edits into a single `batch` command instead of chaining open/set/close calls.',
  '',
  'Typical commands (pass them verbatim as `command`, quoting any path that contains spaces):',
  '  create deck.pptx --layout blank        create a new file (refuses to overwrite)',
  '  get deck.pptx                         read structure, text and layout facts',
  '  query deck.pptx "slide[*].title"      select values with a page-designer style query',
  '  set deck.pptx "slide 1 title" "Hello" replace a value by selector',
  '  add deck.pptx slide --title "Intro"   add an element',
  '  remove deck.pptx "slide 3"            remove an element',
  '  move deck.pptx "slide 3" --to 1       reorder',
  '  validate deck.pptx                    structural validation, non-zero exit on errors',
  '  view deck.pptx text                   plain text dump (no rendering backend needed)',
  '  view deck.pptx outline                outline of the document',
  '  view deck.pptx stats                  shape/text/style statistics',
  '  view deck.pptx issues                 layout and overflow problems',
  '  view deck.pptx screenshot --page 1    render a page image; needs a rendering backend and fonts',
  '  batch deck.pptx --ops ops.json        many edits in one atomically flushed pass',
  '  dump deck.pptx --out tree.json        raw document tree',
  '  merge output.pptx a.pptx b.pptx       concatenate documents',
  '',
  'Rendering (`screenshot`, `html`, `pdf`, `png`) needs a rendering backend and the fonts the document uses; `text`, `outline`, `stats`, `issues`, `get`, `set`, `add`, `remove`, `query`, `batch`, `validate`, `dump` and `merge` work without one.',
  'If a command fails, the exit code and stderr say whether the document, the path or the rendering backend is at fault — report that instead of retrying blindly.',
].join('\n');

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
        },
        required: ['exitCode', 'stdout', 'stderr'],
        additionalProperties: false,
      },
      render(_args, value) {
        const result = value ?? {};
        const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        if (result.exitCode === 0) return [{ type: 'text', text: text || '(no output)' }];
        return [{ type: 'text', text: `exit ${result.exitCode}\n${text}` }];
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
      const argvTail = normalizeCommand(args?.command);
      const cwd = await sessionDirectory(ctx, exec, args?.cwd);
      const result = await spawnCollect(ctx, settings, argvTail, { cwd, signal: exec?.signal });
      return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
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
            runtime: status.runtime,
            status,
            skills,
            knownSkills: KNOWN_SKILLS,
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
          runtime: body.runtime,
          wslDistro: body.wslDistro,
        });
        const status = await probe(ctx, candidate);
        return sendJson(res, 200, { ok: true, data: status });
      }

      if (route === '/save') {
        const settings = await writeSettings({
          binaryPath: body.binaryPath,
          runtime: body.runtime,
          wslDistro: body.wslDistro,
          skillsEnabled: body.skillsEnabled,
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
    name: `officecli-${entry.slug}`,
    description: entry.description,
  }));
}

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

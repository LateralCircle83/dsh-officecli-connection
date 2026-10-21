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
import { readdirSync, statSync } from 'node:fs';
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

const DEFAULT_SETTINGS = Object.freeze({
  binaryPath: '',
  skillsEnabled: true,
  yieldToBuiltin: true,
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
  return {
    binaryPath: typeof source.binaryPath === 'string' ? source.binaryPath.trim() : '',
    skillsEnabled: source.skillsEnabled !== false,
    yieldToBuiltin: source.yieldToBuiltin !== false,
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
 * Guides that collide with the desktop build's own office skills. When both
 * stacks are mounted the model reads two near-identical manuals for .pptx,
 * .docx and .xlsx; yielding the overlap leaves exactly one guide per format.
 * The built-in package is mounted by the Desktop host outside this profile, so
 * this plugin cannot unload it — it can only step aside.
 */
const OVERLAP_SLUGS = new Set(['pptx', 'word', 'excel']);

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
        if (!settings.skillsEnabled || !settings.binaryPath) return [];
        const status = await probe(ctx, settings, options.signal);
        if (!status.ok) {
          providerError = `probe: ${status.error || 'not ok'}`;
          return [];
        }
        // Synchronous, service-free: a provider must never await the skills
        // service from inside list(). `snapshot()` gathers every provider —
        // including this one — so awaiting it here deadlocks the catalog and
        // takes the whole session down with it.
        const builtin = Boolean(builtinOfficeAssets()?.skills?.length);
        const key = [
          settings.binaryPath,
          status.version,
          builtin ? 'builtin' : 'solo',
          settings.yieldToBuiltin ? 'yield' : 'keep',
        ].join('|');
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
        const list =
          settings.yieldToBuiltin && builtin
            ? all.filter((candidate) => !OVERLAP_SLUGS.has(candidate.locator.slug))
            : all;
        skillCache = { key, list, all };
        providerError = '';
        return list;
      } catch (caught) {
        providerError = `list: ${caught instanceof Error ? caught.message : String(caught)}`;
        return [];
      }
    },

    async get(candidate, options = {}) {
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
            office: officeSkillState(),
            catalog: await catalogSummary(ctx),
            providerError,
            overlapSlugs: [...OVERLAP_SLUGS],
          },
        });
      }


      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
      const body = await readJsonBody(req);

      if (route === '/yield') {
        const settings = await writeSettings({
          yieldToBuiltin: typeof body.yieldToBuiltin === 'boolean' ? body.yieldToBuiltin : undefined,
        });
        invalidateSkills();
        return sendJson(res, 200, { ok: true, data: { settings, office: officeSkillState() } });
      }

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
          skillsEnabled: body.skillsEnabled,
          yieldToBuiltin: body.yieldToBuiltin,
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
    overlaps: OVERLAP_SLUGS.has(entry.slug),
  }));
}

// ------------------------------------------------- built-in office skills --
//
// The desktop build mounts `@deepseek-ai/dsh-skill-office` from its own host
// package, outside the profile composition — not as a loader row this plugin
// could toggle. So "turning the built-in skills off" is not reachable from
// here. What is reachable: when that stack is present, stop publishing our own
// .pptx / .docx / .xlsx guides and let the built-in ones own those formats.

/**
 * Where a desktop build unpacks the built-in office skill assets. Their
 * presence is a synchronous, service-free signal that the seven office-* skills
 * are mounted — the one kind of question a skill provider may safely ask from
 * inside list().
 */
function builtinOfficeAssets() {
  const roots = [];
  if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'runtime', 'office-skills'));
  }
  if (typeof process.execPath === 'string' && process.execPath) {
    roots.push(path.join(path.dirname(process.execPath), 'resources', 'runtime', 'office-skills'));
  }
  for (const root of roots) {
    try {
      if (!statSync(root).isDirectory()) continue;
      const skills = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^office(-|$)/.test(entry.name))
        .map((entry) => entry.name);
      if (skills.length > 0) return { root, skills };
    } catch {
      // absent or unreadable: try the next candidate
    }
  }
  return undefined;
}

function officeSkillState() {
  const assets = builtinOfficeAssets();
  const names = assets ? assets.skills : [];
  return {
    builtin: { present: names.length > 0, count: names.length, names },
    overlap: [...OVERLAP_SLUGS],
  };
}

/**
 * What the model actually sees. The assets on disk say nothing about whether the
 * host mounted them, so this asks the skills service — safe here, because a
 * request handler is not inside the catalog collection (unlike list()).
 */
async function catalogSummary(ctx) {
  try {
    const snapshot = await ctx.skills.snapshot();
    const skills = Array.isArray(snapshot) ? snapshot : (snapshot && snapshot.skills) || [];
    const names = skills.map((skill) => String((skill && skill.name) || '')).filter(Boolean);
    return {
      present: true,
      builtin: names.filter((name) => name === 'office' || name.startsWith('office-')),
      officecli: names.filter((name) => name.startsWith('officecli-')),
    };
  } catch (caught) {
    return {
      present: false,
      builtin: [],
      officecli: [],
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
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

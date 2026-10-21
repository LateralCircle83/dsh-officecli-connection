// Two regressions this file guards against:
//
// 1. Reentrancy — the skills service collects every provider's list(), so a
//    provider that awaits the service from inside list() deadlocks the catalog
//    and hangs the session. The snapshot() mock below has that exact shape.
// 2. Route order — a POST branch that reads `body` before it is parsed dies
//    with a TDZ error only at runtime, when a user clicks the switch. The
//    route tests at the bottom exercise the real handler.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const liveSettings = path.join(os.homedir(), '.dsh', 'officecli-connection', 'settings.json');
const binaryPath = (() => {
  if (process.env.OFFICECLI_TEST_BINARY) return process.env.OFFICECLI_TEST_BINARY;
  try {
    return JSON.parse(readFileSync(liveSettings, 'utf8')).binaryPath;
  } catch {
    return '';
  }
})();
if (!binaryPath) {
  console.error('set OFFICECLI_TEST_BINARY, or configure the plugin once so a path can be borrowed');
  process.exit(2);
}

// Isolated state dir: the tests flip the toggle, and the live profile must not move.
const home = mkdtempSync(path.join(os.tmpdir(), 'officecli-smoke-'));
mkdirSync(path.join(home, 'officecli-connection'), { recursive: true });
writeFileSync(
  path.join(home, 'officecli-connection', 'settings.json'),
  JSON.stringify({ binaryPath, skillsEnabled: true }, null, 2),
);
process.env.DSH_HOME = home;
process.resourcesPath = process.env.OFFICECLI_TEST_RESOURCES ?? process.resourcesPath;

const registry = {};
const routes = {};

const subprocess = {
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ exitCode: code ?? 0, signal: null }));
      child.on('error', () => resolve({ exitCode: 1, signal: null }));
    });
    return {
      done,
      collected: {
        stdout: {
          readFrom() {
            return { text: Buffer.concat(chunks).toString('utf8'), nextOffset: 0, lossy: false };
          },
        },
      },
      kill() {
        child.kill();
      },
    };
  },
};

const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  tools: {
    register(definition) {
      registry.tool = definition;
      return () => {};
    },
  },
  skills: {
    registerProvider(create) {
      registry.provider = create({ signal: new AbortController().signal, invalidate() {} });
      return () => {};
    },
    async snapshot() {
      return registry.provider.list({});
    },
  },
  webServer: {
    register({ path: prefix, handler }) {
      routes[prefix] = handler;
      return () => {};
    },
  },
  workingDirectory: { ensure: async () => process.cwd() },
  subprocess,
};

apply(ctx);

const timed = async (label, promise, ms = 20000) => {
  const started = Date.now();
  const result = await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
  console.log(`${label}: ok in ${Date.now() - started}ms`);
  return result;
};

const list = await timed('list()', registry.provider.list({}));
const entry = list.find((item) => item.name === 'officecli');
const guides = list.filter((item) => item.name.startsWith('officecli-'));
console.log('entries:', list.length, '| guides:', guides.length, '| workflow entry:', Boolean(entry));
console.log('catalog order:', list.map((item) => item.name).join(', '));

const workflow = await registry.provider.get(entry, {});
console.log('workflow body bytes:', workflow?.content?.length, '| starts:', workflow?.content?.slice(0, 40).replace(/\n/g, ' '));

const loaded = await timed('get()', registry.provider.get({ name: 'officecli-word-form', locator: { slug: 'word-form' } }, {}));
console.log('get() name:', loaded?.name, 'bytes:', loaded?.content?.length);

// ---------------------------------------------------------------- routes --

async function call(route, method, body) {
  const handler = Object.values(routes)[0];
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = '/api/dsh-officecli' + route;
  req.headers = { host: '127.0.0.1:59999', origin: 'http://127.0.0.1:59999', 'content-type': 'application/json' };
  const res = {
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk) {
      this.payload = JSON.parse(Buffer.from(chunk).toString('utf8'));
    },
  };
  await handler(req, res);
  return { status: res.statusCode, payload: res.payload };
}

const state = await call('/state', 'GET');
console.log('/state:', state.status, '| workflow entry:', state.payload.data.workflow?.name, '| skills listed:', state.payload.data.skills.length);

const saved = await call('/save', 'POST', { binaryPath, skillsEnabled: true });
console.log('/save:', saved.status, '| re-probed:', saved.payload.data.status.version);

rmSync(home, { recursive: true, force: true });

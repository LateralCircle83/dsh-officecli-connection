// Reentrancy probe: the skills service collects every provider's list(), so a
// provider that awaits the service from inside list() deadlocks. This harness
// simulates exactly that shape and fails if list() does not return.
import { spawn } from 'node:child_process';
import { apply } from '../lib/index.js';

const registry = {};
const subprocess = {
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ exitCode: code ?? 0, signal: null }));
      child.on('error', (error) => resolve({ exitCode: 1, signal: null, error }));
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
      stderr: () => stderr,
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
    // Mirrors the real service: collecting the catalog awaits each provider.
    async snapshot() {
      return registry.provider.list({});
    },
  },
  webServer: { register: () => () => {} },
  workingDirectory: { ensure: async () => process.cwd() },
  subprocess,
};

process.resourcesPath = process.env.OFFICECLI_TEST_RESOURCES ?? process.resourcesPath; // what the desktop shell exposes
apply(ctx);

const timed = async (label, promise, ms = 20000) => {
  const started = Date.now();
  const result = await Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);
  console.log(`${label}: ok in ${Date.now() - started}ms`);
  return result;
};

const list = await timed('list()', registry.provider.list({}));
console.log('catalog size:', list.length, '->', list.map((item) => item.name).join(', '));
console.log('overlap hidden:', !list.some((item) => ['officecli-pptx', 'officecli-docx', 'officecli-xlsx'].includes(item.name)));

const loaded = await timed('get()', registry.provider.get({ name: 'officecli-word-form', locator: { slug: 'word-form' } }, {}));
console.log('get() name:', loaded?.name, 'bytes:', loaded?.content?.length);


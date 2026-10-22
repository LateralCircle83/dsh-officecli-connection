// The setting accepts a path or a bare command name; the resolver decides which
// one it got, and a wrong guess sends every spawn to the wrong place.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { resolveBinaryPath } from '../lib/index.js';

const WINDOWS = process.platform === 'win32';

test('an empty setting is unset, not "not on PATH"', () => {
  assert.deepEqual(resolveBinaryPath('', { PATH: '' }), { path: '', kind: 'unset' });
  assert.deepEqual(resolveBinaryPath('   ', { PATH: '' }), { path: '', kind: 'unset' });
});

test('anything with a separator or drive letter is taken as a path', () => {
  assert.deepEqual(resolveBinaryPath('C:\\tools\\officecli.exe', { PATH: '' }), {
    path: 'C:\\tools\\officecli.exe',
    kind: 'path',
  });
  assert.deepEqual(resolveBinaryPath('/usr/local/bin/officecli', { PATH: '' }), {
    path: '/usr/local/bin/officecli',
    kind: 'path',
  });
  assert.deepEqual(resolveBinaryPath('./officecli', { PATH: '' }), { path: './officecli', kind: 'path' });
});

test('a bare name is looked up on PATH', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ocli-resolve-'));
  try {
    const name = WINDOWS ? 'officecli.exe' : 'officecli';
    const binary = path.join(directory, name);
    await writeFile(binary, 'stub');
    if (!WINDOWS) await chmod(binary, 0o755);

    const found = resolveBinaryPath('officecli', { PATH: directory, PATHEXT: '.EXE;.CMD' });
    assert.equal(found.kind, 'path-env');
    assert.equal(path.resolve(found.path), path.resolve(binary));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a bare name that PATH does not hold is reported as not on PATH', () => {
  const missing = resolveBinaryPath('officecli', { PATH: path.join(os.tmpdir(), 'definitely-not-here') });
  assert.deepEqual(missing, { path: '', kind: 'not-on-path' });
});

test('PATH is read case-insensitively, because Windows spells it Path', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ocli-resolve-'));
  try {
    const name = WINDOWS ? 'officecli.exe' : 'officecli';
    const binary = path.join(directory, name);
    await writeFile(binary, 'stub');
    if (!WINDOWS) await chmod(binary, 0o755);

    const found = resolveBinaryPath('officecli', { Path: directory, PATHEXT: '.EXE' });
    assert.equal(found.kind, 'path-env');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

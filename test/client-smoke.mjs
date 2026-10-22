// The settings page has no test harness in a browser here, so this loads the
// client module against a stub React and checks the two things that regressed:
// the page must follow the harness language, and a failure must be printed once.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (effect) => effect(),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
}

function loadModule(active) {
  let definition = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value; } } },
    console,
  };
  vm.runInNewContext(source, sandbox);
  assert.ok(definition, 'client module did not call __ModuleLoader__.load');

  const locale = {
    getLocale: () => ({ active, locales: [], revision: 1 }),
    subscribe: () => () => {},
  };
  let registered = null;
  const ctx = {
    locale,
    slots: {
      inject: (_name, factory) => factory(),
      register: (registration, component) => { registered = { registration, component }; return () => {}; },
    },
  };
  const module = definition.factory((name) => (name === 'react' ? makeReact() : {}));
  module.apply(ctx);
  return { module, registered };
}

function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object' && node.children) return textOf(node.children);
  return '';
}

test('the page follows the harness language, not the browser one', () => {
  const english = loadModule('en');
  const englishText = textOf(english.registered.component());
  assert.match(englishText, /Point DeepSeek Harness at an OfficeCLI binary/);

  const chinese = loadModule('zh-CN');
  const chineseText = textOf(chinese.registered.component());
  assert.match(chineseText, /把你自行安装的 OfficeCLI 二进制接到 DeepSeek Harness/);
  assert.doesNotMatch(chineseText, /Point DeepSeek Harness/);
});

test('the settings section mounts where the sidebar expects it', () => {
  const { module, registered } = loadModule('en');
  // Spread first: arrays made inside the vm realm have a different prototype.
  assert.deepEqual([...module.inject], ['slots', 'locale']);
  assert.equal(registered.registration.name, 'settings.section');
  assert.equal(registered.registration.id, 'officecli');
  assert.equal(registered.registration.order, 30);
  assert.equal(typeof registered.registration.label, 'function');
  assert.equal(registered.registration.label(), 'OfficeCLI');
});

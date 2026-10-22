/**
 * Client half: one page in Settings. It only reads and writes the Host API
 * (GET /state, POST /probe, POST /save); no OfficeCLI knowledge lives here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-officecli-connection',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const BASE = '/api/dsh-officecli';

    const EN = {
      navLabel: 'OfficeCLI',
      title: 'OfficeCLI',
      subtitle: 'Point DeepSeek Harness at an OfficeCLI binary you installed yourself.',
      pathLabel: 'Binary path',
      pathHint: 'Example: C:\\Users\\you\\.local\\bin\\officecli.exe — or just "officecli" when it is already on PATH',
      pathHintOther: 'Example: /home/you/.local/bin/officecli — or just "officecli" when it is already on PATH',
      guidesMounted: 'mounted as runtime skills',
      guidesNone: 'None — the path above is not a working binary, so the model has no manual to read.',
      test: 'Test',
      save: 'Save',
      saving: 'Saving…',
      testing: 'Testing…',
      saved: 'Saved.',
      notConfigured: 'No binary configured yet.',
      okPrefix: 'Detected OfficeCLI',
      skillsTitle: 'Bundled skills',
      scopeTitle: 'One workflow, stated plainly',
      scopeHint: 'Another provider may publish Office skills — the desktop build ships its own, and a third-party plugin can add more. This plugin does not hide them: it cannot know what you installed, and hiding is a bet that ages badly. Instead it publishes one entry point that says which skills belong to the OfficeCLI workflow and why mixing engines in one file is a data-loss bug.',
      scopeEntry: 'Entry point:',
      installNote: 'OfficeCLI itself is not downloaded or updated by this plugin.',
    };

    const ZH = {
      navLabel: 'OfficeCLI',
      title: 'OfficeCLI',
      subtitle: '把你自行安装的 OfficeCLI 二进制接到 DeepSeek Harness。',
      pathLabel: '二进制路径',
      pathHint: '例：C:\\Users\\you\\.local\\bin\\officecli.exe —— 已在 PATH 上时直接填 "officecli"',
      pathHintOther: '例：/home/you/.local/bin/officecli —— 已在 PATH 上时直接填 "officecli"',
      guidesMounted: '已作为运行时技能挂载',
      guidesNone: '一个也没有 —— 上面的路径不是可用的二进制，模型没有手册可读。',
      test: '测试',
      save: '保存',
      saving: '保存中…',
      testing: '测试中…',
      saved: '已保存。',
      notConfigured: '尚未配置二进制。',
      okPrefix: '已检测到 OfficeCLI',
      skillsTitle: '内置技能',
      scopeTitle: '一条工作流，讲清楚',
      scopeHint: '别的提供方也可能发布 Office 技能——桌面版自带一套，第三方插件还能再加。本插件不去隐藏它们：它不可能知道你装了什么，而“屏蔽”是一个很快就过时的赌注。它改为发布一个入口条目，说清哪些技能属于 OfficeCLI 工作流，以及为什么在同一个文件里混用两种引擎是数据损失级的 bug。',
      scopeEntry: '入口：',
      installNote: '本插件不下载、也不更新 OfficeCLI 本体。',
    };

    // The harness has its own language preference, separate from the browser's.
    // Reading navigator.language made the page ignore it entirely: a user who
    // switched the app to English kept seeing Chinese here.
    const copyFor = (active) => (/^zh/i.test(active || '') ? ZH : EN);

    let localeService = null;

    function activeLocaleId() {
      try {
        const snapshot = localeService && localeService.getLocale ? localeService.getLocale() : null;
        if (snapshot && snapshot.active) return snapshot.active;
      } catch {
        // A locale service that throws must not take the whole page down.
      }
      return (typeof navigator !== 'undefined' && navigator.language) || '';
    }

    /** Re-render when the harness switches language, not only when it remounts. */
    function useActiveLocale() {
      const [active, setActive] = React.useState(activeLocaleId);
      React.useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined;
        const sync = () => setActive(activeLocaleId());
        sync();
        return localeService.subscribe(sync);
      }, []);
      return active;
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0', color: 'inherit', maxWidth: 720 },
      title: { fontSize: 18, fontWeight: 600, margin: 0 },
      subtitle: { fontSize: 13, opacity: 0.72, margin: 0 },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 12, fontWeight: 600, opacity: 0.86 },
      hint: { fontSize: 11, opacity: 0.6, lineHeight: 1.5 },
      input: {
        font: 'inherit',
        fontSize: 13,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'rgba(127,127,127,0.08)',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      button: {
        font: 'inherit',
        fontSize: 13,
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,0.35)',
        background: 'rgba(127,127,127,0.12)',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: {
        font: 'inherit',
        fontSize: 13,
        padding: '7px 14px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: '#247bbf',
        color: '#fff',
        cursor: 'pointer',
      },
      status: { fontSize: 12, lineHeight: 1.6, padding: '8px 10px', borderRadius: 8, background: 'rgba(127,127,127,0.1)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
      th: { textAlign: 'left', padding: '6px 8px', opacity: 0.66, fontWeight: 600, borderBottom: '1px solid rgba(127,127,127,0.25)' },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,0.14)', verticalAlign: 'top' },
    };

    /** One place for the API protocol: unwrap `{ ok, data, error }` or throw. */
    async function request(method, route, body) {
      const init = { method, headers: { 'content-type': 'application/json' } };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await fetch(BASE + route, init);
      const payload = await response.json().catch(() => ({ ok: false, error: 'invalid JSON response' }));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
      return payload.data;
    }

    function Section() {
      const [state, setState] = React.useState(null);
      const [form, setForm] = React.useState({ binaryPath: '' });
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState('');

      const copy = copyFor(useActiveLocale());
      const skills = state && Array.isArray(state.skills) ? state.skills : [];
      // The catalogue is the ten guides plus this plugin's own workflow entry.
      const guideCount = skills.length + 1;

      const load = React.useCallback(async () => {
        try {
          const data = await request('GET', '/state');
          setState(data);
          setForm({ binaryPath: data.settings.binaryPath });
          return data;
        } catch (error) {
          setMessage(String(error.message || error));
          return null;
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const run = async (kind, action) => {
        setBusy(kind);
        setMessage('');
        try {
          await action();
        } catch (error) {
          setMessage(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const onTest = () =>
        run('test', async () => {
          const result = await request('POST', '/probe', form);
          setState((current) => ({ ...(current || {}), status: result }));
          // The status line below already prints the error; repeating it here is
          // what produced two identical boxes.
          setMessage(result.ok ? copy.okPrefix + ' ' + result.version : '');
        });

      const onSave = () =>
        run('save', async () => {
          await request('POST', '/save', form);
          setMessage(copy.saved);
          await load();
        });

      const status = state && state.status;

      return h(
        'div',
        { style: styles.page },
        h('h2', { style: styles.title }, copy.title),
        h('p', { style: styles.subtitle }, copy.subtitle),

        h(
          'div',
          { style: styles.field },
          h('label', { style: styles.label }, copy.pathLabel),
          h('input', {
            style: styles.input,
            value: form.binaryPath,
            spellCheck: false,
            placeholder: 'C:\\Users\\you\\.local\\bin\\officecli.exe',
            onChange: (event) => setForm({ binaryPath: event.target.value }),
          }),
          h('span', { style: styles.hint }, (state && state.platform === 'win32') ? copy.pathHint : copy.pathHintOther),
        ),

        h(
          'div',
          { style: styles.row },
          h(
            'button',
            { style: styles.primary, type: 'button', disabled: Boolean(busy), onClick: onSave },
            busy === 'save' ? copy.saving : copy.save,
          ),
          h(
            'button',
            { style: styles.button, type: 'button', disabled: Boolean(busy), onClick: onTest },
            busy === 'test' ? copy.testing : copy.test,
          ),
        ),

        message ? h('div', { style: styles.status }, message) : null,

        h(
          'div',
          { style: styles.status },
          status && status.ok
            ? copy.okPrefix + ' ' + status.version + (status.resolved && status.resolved !== form.binaryPath ? ' → ' + status.resolved : '')
            : (status && status.error) || copy.notConfigured,
        ),

        h(
          'div',
          { style: { ...styles.hint, marginTop: 4 } },
          skills.length ? guideCount + ' ' + copy.guidesMounted : copy.guidesNone,
        ),

        h('h3', { style: { ...styles.title, fontSize: 14, marginTop: 8 } }, copy.skillsTitle),
        skills.length
          ? h(
              'table',
              { style: styles.table },
              h('thead', null, h('tr', null, h('th', { style: styles.th }, 'Skill'), h('th', { style: styles.th }, 'Description'))),
              h(
                'tbody',
                null,
                skills.map((skill) =>
                  h(
                    'tr',
                    { key: skill.name },
                    h('td', { style: { ...styles.td, fontFamily: 'monospace', whiteSpace: 'nowrap' } }, skill.name),
                    h('td', { style: { ...styles.td, opacity: 0.75 } }, skill.description),
                  ),
                ),
              ),
            )
          : h('span', { style: styles.hint }, copy.guidesNone),

        h('h3', { style: { ...styles.title, fontSize: 14, marginTop: 8 } }, copy.scopeTitle),
        h('p', { style: styles.hint }, copy.scopeHint),
        state && state.workflow
          ? h(
              'div',
              { style: styles.status },
              h('strong', null, copy.scopeEntry + ' '),
              state.workflow.description,
            )
          : null,

        h('span', { style: { ...styles.hint, marginTop: 6 } }, copy.installNote),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeService = ctx.locale || null;
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'officecli',
              order: 30,
              // A function, so the sidebar follows a language switch too.
              label: () => copyFor(activeLocaleId()).navLabel,
            },
            Section,
          ),
        );
      },
    };
  },
});

/**
 * Client half: one page in Settings. It only reads and writes the Host API
 * (GET /state, POST /probe, POST /save); no OfficeCLI knowledge lives here.
 */
window.__ModuleLoader__.load({
  id: 'dsh-officecli-connection',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const EN = {
      navLabel: 'OfficeCLI',
      title: 'OfficeCLI',
      subtitle: 'Point DeepSeek Harness at an OfficeCLI binary you installed yourself.',
      pathLabel: 'Binary path',
      pathHint: 'Example: C:\\Users\\you\\.local\\bin\\officecli.exe',
      pathHintOther: 'Example: /home/you/.local/bin/officecli',
      skillsLabel: 'Expose OfficeCLI skills',
      skillsHint: 'Injects the bundled SKILL.md files as runtime skills. Nothing is written into a workspace.',
      test: 'Test',
      save: 'Save',
      saving: 'Saving…',
      testing: 'Testing…',
      saved: 'Saved.',
      notConfigured: 'No binary configured yet.',
      okPrefix: 'Detected OfficeCLI',
      skillsTitle: 'Bundled skills',
      skillsHint2: 'These coexist with the built-in office-* skills: those render through LibreOffice Kit, these run through your OfficeCLI binary.',
      skillsEmpty: 'No skills reported. Save a working path first.',
      stateLabel: 'State',
      installNote: 'OfficeCLI itself is not downloaded or updated by this plugin.',
      missing: 'not configured',
    };

    const ZH = {
      navLabel: 'OfficeCLI',
      title: 'OfficeCLI',
      subtitle: '把你自行安装的 OfficeCLI 二进制接到 DeepSeek Harness。',
      pathLabel: '二进制路径',
      pathHint: '例：C:\\Users\\you\\.local\\bin\\officecli.exe',
      pathHintOther: '例：/home/you/.local/bin/officecli',
      skillsLabel: '接入 OfficeCLI 技能',
      skillsHint: '把内置 SKILL.md 作为运行时技能注入，不向任何工作目录写文件。',
      test: '测试',
      save: '保存',
      saving: '保存中…',
      testing: '测试中…',
      saved: '已保存。',
      notConfigured: '尚未配置二进制。',
      okPrefix: '已检测到 OfficeCLI',
      skillsTitle: '内置技能',
      skillsHint2: '它们与内置的 office-* 技能并存：那组走 LibreOffice Kit 渲染，这一组走你自己装的 OfficeCLI。',
      skillsEmpty: '没有读到技能，请先保存一个可用的路径。',
      stateLabel: '状态',
      installNote: '本插件不下载、也不更新 OfficeCLI 本体。',
      missing: '未配置',
    };

    const t = () => (/^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '') ? ZH : EN);

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

    function Section() {
      const [state, setState] = React.useState(null);
      const [form, setForm] = React.useState({ binaryPath: '', skillsEnabled: true });
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [probe, setProbe] = React.useState(null);

      const call = React.useCallback(async (method, body) => {
        const init = { method, headers: { 'content-type': 'application/json' } };
        if (body) init.body = JSON.stringify(body);
        const response = await fetch('/api/dsh-officecli' + (method === 'GET' ? '/state' : ''), init);
        const payload = await response.json().catch(() => ({ ok: false, error: 'invalid JSON response' }));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
        return payload.data;
      }, []);

      const post = React.useCallback(async (route, body) => {
        const response = await fetch('/api/dsh-officecli' + route, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const payload = await response.json().catch(() => ({ ok: false, error: 'invalid JSON response' }));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status);
        return payload.data;
      }, []);

      const load = React.useCallback(async () => {
        try {
          const data = await call('GET');
          setState(data);
          setForm({
            binaryPath: data.settings.binaryPath,
            skillsEnabled: data.settings.skillsEnabled,
          });
          setProbe(data.status);
        } catch (error) {
          setMessage(String(error.message || error));
        }
      }, [call]);

      React.useEffect(() => {
        load();
      }, [load]);

      const update = (patch) => setForm((current) => ({ ...current, ...patch }));

      const onTest = async () => {
        setBusy('test');
        setMessage('');
        try {
          const result = await post('/probe', form);
          setProbe(result);
          setMessage(result.ok ? t().okPrefix + ' ' + result.version : result.error);
        } catch (error) {
          setMessage(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const onSave = async () => {
        setBusy('save');
        setMessage('');
        try {
          const result = await post('/save', form);
          setState((current) => ({ ...(current || {}), settings: result.settings, status: result.status }));
          setProbe(result.status);
          setMessage(result.status.ok ? t().saved + ' ' + t().okPrefix + ' ' + result.status.version : t().saved + ' ' + (result.status.error || ''));
          const refreshed = await call('GET');
          setState(refreshed);
        } catch (error) {
          setMessage(String(error.message || error));
        } finally {
          setBusy('');
        }
      };

      const copy = t();
      const skills = state && Array.isArray(state.skills) ? state.skills : [];

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
            onChange: (event) => update({ binaryPath: event.target.value }),
          }),
          h('span', { style: styles.hint }, (state && state.platform === 'win32') ? copy.pathHint : copy.pathHintOther),
        ),

        h(
          'label',
          { style: { ...styles.row, cursor: 'pointer', fontSize: 13 } },
          h('input', {
            type: 'checkbox',
            checked: form.skillsEnabled,
            onChange: (event) => update({ skillsEnabled: event.target.checked }),
          }),
          h('span', null, copy.skillsLabel),
        ),
        h('span', { style: styles.hint }, copy.skillsHint),
        h('span', { style: styles.hint }, copy.skillsHint2),

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
          probe && probe.ok
            ? copy.okPrefix + ' ' + probe.version
            : copy.notConfigured + (probe && probe.error ? ' — ' + probe.error : ''),
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
          : h('span', { style: styles.hint }, copy.skillsEmpty),

        h('span', { style: { ...styles.hint, marginTop: 6 } }, copy.installNote),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'officecli',
              order: 30,
              label: () => t().navLabel,
            },
            Section,
          ),
        );
      },
    };
  },
});

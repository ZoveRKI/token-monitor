'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPreviewIpc,
  initializeLocalPreview,
  previewEnvironment,
  previewIpcHandler,
  previewSettings
} = require('../../src/electron/localPreview');
const { limitsConfigFromSettings } = require('../../src/electron/runtimeConfig');
const { collectLimitsOnce } = require('../../src/shared/limits/collector');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-preview-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeApp({ packaged = false, appPath } = {}) {
  const calls = [];
  return {
    isPackaged: packaged,
    calls,
    getAppPath() { return appPath; },
    setName(name) { calls.push(['name', name]); },
    setPath(key, value) { calls.push(['path', key, value]); },
    setAppLogsPath(value) { calls.push(['logs', value]); }
  };
}

test('normal source startup leaves the environment and app paths untouched', (t) => {
  const directory = fixture(t);
  const app = fakeApp({ appPath: directory });
  const env = { HOME: '/example/home', CLAUDE_WEB_COOKIE: 'existing-cookie' };
  const before = { ...env };

  assert.equal(initializeLocalPreview(app, env), null);
  assert.deepEqual(env, before);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a normal packaged app ignores a preview environment variable', (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'token-monitor' }));
  const root = path.join(directory, 'unused-runtime');
  const env = { TOKEN_MONITOR_PREVIEW_ROOT: root, CLAUDE_WEB_COOKIE: 'existing-cookie' };
  const before = { ...env };
  const app = fakeApp({ packaged: true, appPath: directory });

  assert.equal(initializeLocalPreview(app, env), null);
  assert.equal(fs.existsSync(root), false);
  assert.deepEqual(env, before);
  assert.deepEqual(app.calls, []);
});

test('source preview redirects all app state and seeds private settings', (t) => {
  const directory = fixture(t);
  const root = path.join(directory, 'runtime');
  const env = { TOKEN_MONITOR_PREVIEW_ROOT: root, HOME: '/example/home', CLAUDE_WEB_COOKIE: 'ambient-cookie' };
  const app = fakeApp();
  const preview = initializeLocalPreview(app, env);

  assert.equal(preview.root, root);
  assert.deepEqual(app.calls, [
    ['name', 'Token Monitor Preview'],
    ['path', 'userData', path.join(root, 'user-data')],
    ['path', 'sessionData', path.join(root, 'session')],
    ['path', 'crashDumps', path.join(root, 'crashes')],
    ['logs', path.join(root, 'logs')]
  ]);
  for (const value of Object.values(preview.directories)) assert.equal(fs.statSync(value).isDirectory(), true);
  const settingsPath = path.join(root, 'user-data', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.hubMode, 'local');
  assert.equal(settings.limitProviders, '');
  assert.equal(settings.clients, '');
  assert.equal(settings.claudeWebCookie, undefined);
  assert.deepEqual(settings.lastViewState, { period: 'today', breakdown: 'limits' });
  assert.equal(env.CLAUDE_WEB_COOKIE, undefined);
  assert.equal(env.TOKEN_MONITOR_SHARED_DIR, path.join(root, 'shared'));
  assert.equal(env.TOKSCALE_CONFIG_DIR, path.join(root, 'tokscale'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  }
});

test('packaged preview uses embedded metadata instead of an inherited runtime path', (t) => {
  const directory = fixture(t);
  const root = path.join(directory, 'embedded-runtime');
  const otherRoot = path.join(directory, 'inherited-runtime');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ tokenMonitorPreview: { root } }));
  const app = fakeApp({ packaged: true, appPath: directory });
  const env = { TOKEN_MONITOR_PREVIEW_ROOT: otherRoot };

  assert.equal(initializeLocalPreview(app, env).root, root);
  assert.equal(env.TOKEN_MONITOR_PREVIEW_ROOT, root);
  assert.equal(fs.existsSync(otherRoot), false);
});

test('preview restart preserves the existing settings file', (t) => {
  const directory = fixture(t);
  const root = path.join(directory, 'runtime');
  const settingsPath = path.join(root, 'user-data', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const saved = '{"language":"ja","glassOpacity":42}\n';
  fs.writeFileSync(settingsPath, saved);

  initializeLocalPreview(fakeApp(), { TOKEN_MONITOR_PREVIEW_ROOT: root });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), saved);
});

test('preview environment removes ambient credentials and overrides while retaining OS and proxy settings', () => {
  const inherited = {
    HOME: '/example/home', PATH: '/example/bin', HTTPS_PROXY: 'http://proxy.example:8080',
    no_proxy: 'localhost', LANG: 'zh_CN.UTF-8',
    CLAUDE_WEB_COOKIE: 'secret-cookie', ANTHROPIC_API_KEY: 'secret-key',
    OPENAI_API_KEY: 'secret-key', CODEX_HOME: '/example/codex',
    OPENCODE_AUTH_CONTENT: '{"secret":true}', FACTORY_API_KEY: 'secret-key',
    TOKEN_MONITOR_SECRET: 'hub-secret', TOKEN_MONITOR_HUB_URL: 'https://hub.example',
    TOKEN_MONITOR_SHARED_DIR: '/example/production', TOKSCALE_CONFIG_DIR: '/example/config',
    NODE_OPTIONS: '--require /example/injected.js', TOKEN_MONITOR_CLIENTS: 'claude,codex'
  };
  const env = previewEnvironment('/example/preview', inherited);

  for (const key of ['HOME', 'PATH', 'HTTPS_PROXY', 'no_proxy', 'LANG']) assert.equal(env[key], inherited[key]);
  for (const key of ['CLAUDE_WEB_COOKIE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME', 'OPENCODE_AUTH_CONTENT', 'FACTORY_API_KEY', 'TOKEN_MONITOR_SECRET', 'TOKEN_MONITOR_HUB_URL', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(env, key), false, key);
  }
  assert.equal(env.TOKEN_MONITOR_CLIENTS, '');
  assert.equal(env.TOKEN_MONITOR_LIMIT_PROVIDERS, '');
  assert.equal(env.TOKEN_MONITOR_SHARED_DIR, path.join('/example/preview', 'shared'));
  assert.equal(env.TOKSCALE_CONFIG_DIR, path.join('/example/preview', 'tokscale'));
  assert.equal(inherited.CLAUDE_WEB_COOKIE, 'secret-cookie');
});

test('preview settings enforce local manual-Cookie use despite persisted integration settings', () => {
  const input = {
    hubMode: 'client', hubUrl: 'https://hub.example', secret: 'secret', hubHostSecret: 'host-secret',
    clients: 'claude,codex', customScanPaths: { claude: '/example/sessions' }, collectionMode: 'live',
    projectsEnabled: true, historyEnabled: true, sessionUsageArchiveEnabled: true, wslScanEnabled: true,
    limitsEnabled: false, limitProviders: 'claude,codex,workbuddy', claudeWebCookie: 'sk-ant-preview-test',
    opencodeAmbientEnabled: true, opencodeLocalLimitsEnabled: true,
    codexManagedAccounts: [{ id: 'existing' }], antigravityManagedAccounts: [{ id: 'existing' }],
    mimoManagedAccounts: [{ id: 'existing' }], opencodeProfiles: { existing: {} },
    openrouterProfiles: { existing: {} }, thirdPartyProfiles: { existing: {} },
    codexResetForecastEnabled: true, discordRpcEnabled: true, automaticAppUpdates: true,
    startAtLogin: true, exportAutoEnabled: true, windowToggleShortcut: 'Ctrl+Shift+X', edgeDockEnabled: true,
    language: 'ja', glassOpacity: 42
  };
  const settings = previewSettings(input);

  assert.equal(settings.hubMode, 'local');
  for (const key of ['hubUrl', 'secret', 'hubHostSecret', 'clients', 'windowToggleShortcut']) assert.equal(settings[key], '', key);
  assert.equal(settings.deviceId, 'local-preview');
  assert.equal(settings.collectionMode, 'interval');
  assert.deepEqual(settings.customScanPaths, {});
  for (const key of ['projectsEnabled', 'historyEnabled', 'sessionUsageArchiveEnabled', 'wslScanEnabled', 'opencodeAmbientEnabled', 'opencodeLocalLimitsEnabled', 'codexResetForecastEnabled', 'discordRpcEnabled', 'automaticAppUpdates', 'startAtLogin', 'exportAutoEnabled', 'edgeDockEnabled']) {
    assert.equal(settings[key], false, key);
  }
  for (const key of ['codexManagedAccounts', 'antigravityManagedAccounts', 'mimoManagedAccounts']) assert.deepEqual(settings[key], [], key);
  for (const key of ['opencodeProfiles', 'openrouterProfiles', 'thirdPartyProfiles']) assert.deepEqual(settings[key], {}, key);
  assert.equal(settings.limitsEnabled, true);
  assert.equal(settings.limitProviders, 'claude');
  assert.equal(settings.claudeWebCookie, 'sk-ant-preview-test');
  assert.equal(settings.language, 'ja');
  assert.equal(settings.glassOpacity, 42);
  assert.equal(input.hubMode, 'client');
});

test('clearing a preview Cookie removes Claude from collection and cannot restore OAuth fallback', () => {
  const linked = previewSettings({ claudeWebCookie: 'sk-ant-preview-test' });
  const cleared = previewSettings({ ...linked, claudeWebCookie: '' });
  assert.equal(linked.limitProviders, 'claude');
  assert.equal(cleared.limitProviders, '');
  assert.equal(previewSettings({ limitProviders: 'claude' }).limitProviders, '');
});

test('preview enables only Cookie formats accepted by the Claude Web parser', () => {
  for (const cookie of ['sk-ant-preview-test', 'sessionKey=sk-ant-preview-test', '  sk-ant-preview-test  ']) {
    const settings = previewSettings({ claudeWebCookie: cookie });
    assert.equal(settings.limitProviders, 'claude');
    assert.equal(settings.claudeWebCookie, cookie);
  }
  for (const cookie of [undefined, null, '', ' \t\n ', 'invalid-stored-cookie', 'sk-ant-', 'Cookie: sessionKey=sk-ant-preview-test', 'sessionKey=sk-ant-preview-test; other=value', { sessionKey: 'sk-ant-preview-test' }]) {
    const settings = previewSettings({ limitProviders: 'claude', claudeWebCookie: cookie });
    assert.equal(settings.limitProviders, '');
    assert.equal(settings.claudeWebCookie, cookie);
  }
});

test('real limits collection cannot discover credentials or use CLI for missing or malformed preview Cookies', async () => {
  const calls = { stat: 0, read: 0, cli: 0, network: 0 };
  const deps = {
    env: {},
    platform: 'linux',
    claudeCredentialPath: '/example/preview-test/fake-credentials.json',
    stat: async () => { calls.stat += 1; return { mtimeMs: 0 }; },
    readFile: async () => {
      calls.read += 1;
      throw Object.assign(new Error('fake credentials are absent'), { code: 'ENOENT' });
    },
    isClaudeCliAuthenticated: async () => { calls.cli += 1; return false; },
    fetch: async () => { calls.network += 1; throw new Error('fake network transport'); },
    claudeWebFetch: async () => { calls.network += 1; throw new Error('fake Web transport'); }
  };

  for (const cookie of [undefined, '', '   ', 'invalid-stored-cookie', 'Cookie: sessionKey=sk-ant-preview-test', { sessionKey: 'sk-ant-preview-test' }]) {
    const settings = previewSettings({ limitProviders: 'claude', claudeWebCookie: cookie });
    const config = limitsConfigFromSettings(settings, { env: {} });
    const result = await collectLimitsOnce(config, deps);
    assert.deepEqual(result.providers, []);
    assert.deepEqual(calls, { stat: 0, read: 0, cli: 0, network: 0 });
  }

  const valid = limitsConfigFromSettings(previewSettings({ claudeWebCookie: 'sk-ant-preview-test' }), { env: {} });
  const result = await collectLimitsOnce(valid, deps);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].provider, 'claude');
  assert.equal(calls.network > 0, true);
  assert.equal(calls.stat, 0);
  assert.equal(calls.read, 0);
  assert.equal(calls.cli, 0);
});

test('sensitive and unknown IPC channels are denied before their handlers run', () => {
  let calls = 0;
  const handler = () => { calls += 1; };
  for (const channel of ['codex:switchSystemAccount', 'codex:addAccount', 'copilot:signIn', 'cursor:loginManual', 'opencode:saveProfile', 'tokscale:downloadFromNpm', 'appUpdate:install', 'serviceStatus:get', 'future:unknown']) {
    assert.throws(() => previewIpcHandler(channel, handler)({}, 'value'), /Preview/, channel);
  }
  for (const channel of ['limits:saveCredential', 'limits:clearCredential']) {
    for (const provider of ['codex', 'Claude', undefined]) {
      assert.throws(() => previewIpcHandler(channel, handler)({}, provider, {}), /Claude Cookie/);
    }
  }
  assert.equal(calls, 0);
});

test('manual Claude credentials and ordinary UI IPC retain arguments and return values', () => {
  const event = { sender: {} };
  const values = { claudeWebCookie: 'sk-ant-preview-test' };
  const result = { ok: true };
  const calls = [];
  const handler = (...args) => { calls.push(args); return result; };
  for (const channel of ['limits:saveCredential', 'limits:clearCredential']) {
    assert.equal(previewIpcHandler(channel, handler)(event, 'claude', values), result);
  }
  assert.deepEqual(calls, [[event, 'claude', values], [event, 'claude', values]]);
  for (const channel of ['settings:get', 'settings:update', 'stats:get', 'appearance:preview', 'app:openUserData', 'clipboard:write']) {
    assert.equal(previewIpcHandler(channel, handler), handler, channel);
  }
});

test('automatic account discovery answers empty without invoking original handlers', () => {
  let calls = 0;
  const handler = () => { calls += 1; throw new Error('discovery must not run'); };
  const expectations = {
    'cursor:status': { loggedIn: false, accounts: [], linkedCount: 0, managementBlocked: true },
    'opencode:status': { profiles: {}, ambient: null, linked: false },
    'opencode:getProfiles': { profiles: {}, hasEnvVar: false, hasAmbientKey: false, ambientEnabled: false },
    'openrouter:getProfiles': { profiles: {}, hasEnvVar: false },
    'thirdparty:getProfiles': { profiles: {}, hasEnvVar: false },
    'codex:accounts': [], 'antigravity:accounts': [], 'mimo:accounts': []
  };
  for (const [channel, expected] of Object.entries(expectations)) {
    assert.deepEqual(previewIpcHandler(channel, handler)({}, { discover: true, force: true }), expected, channel);
  }
  assert.equal(calls, 0);
});

test('preview IPC wraps registered handlers without changing the Electron object or method receiver', () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { assert.equal(this, ipcMain); handlers.set(channel, handler); },
    on(channel) { assert.equal(this, ipcMain); return channel; }
  };
  const originalHandle = ipcMain.handle;
  const preview = createPreviewIpc(ipcMain);
  let calls = 0;
  preview.handle('codex:switchSystemAccount', () => { calls += 1; });
  preview.handle('settings:get', () => ({ language: 'zh' }));
  assert.throws(() => handlers.get('codex:switchSystemAccount')(), /Preview/);
  assert.equal(calls, 0);
  assert.deepEqual(handlers.get('settings:get')(), { language: 'zh' });
  assert.equal(preview.on('window:close'), 'window:close');
  assert.equal(ipcMain.handle, originalHandle);
});

test('relative preview paths fail before app or environment mutation', () => {
  const env = { TOKEN_MONITOR_PREVIEW_ROOT: 'relative-runtime', CLAUDE_WEB_COOKIE: 'ambient-cookie' };
  const before = { ...env };
  const app = fakeApp();
  assert.throws(() => initializeLocalPreview(app, env), /absolute/);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(env, before);
});

test('preview refuses a directly symlinked root or app data directory', (t) => {
  const directory = fixture(t);
  const target = path.join(directory, 'existing-data');
  fs.mkdirSync(target);
  const marker = path.join(target, 'sentinel');
  fs.writeFileSync(marker, 'existing data');
  const linkedRoot = path.join(directory, 'linked-runtime');
  fs.symlinkSync(target, linkedRoot, 'junction');
  const root = path.join(directory, 'runtime');
  fs.mkdirSync(root);
  fs.symlinkSync(target, path.join(root, 'user-data'), 'junction');

  for (const runtimeRoot of [linkedRoot, root]) {
    const app = fakeApp();
    const env = { TOKEN_MONITOR_PREVIEW_ROOT: runtimeRoot };
    assert.throws(() => initializeLocalPreview(app, env), /symlink/);
    assert.deepEqual(app.calls, []);
    assert.deepEqual(env, { TOKEN_MONITOR_PREVIEW_ROOT: runtimeRoot });
  }
  assert.deepEqual(fs.readdirSync(target), ['sentinel']);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'existing data');
});

test('offline Claude fixture keys exercise real credential saves and multi-organization collection', async () => {
  const { createClaudeMockFetch } = require('../../src/electron/preview/claudeMock');
  const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const mockFetch = createClaudeMockFetch();
  let settings = previewSettings();
  const commands = createCredentialCommands({
    getSettings: () => settings,
    applySettingsPatch: (patch) => (settings = previewSettings({ ...settings, ...patch })),
    probeDeps: () => ({ env: {}, claudeWebFetch: mockFetch, providerRuntimeState: new Map() }),
    env: {}
  });
  const runtime = createLimitsRuntime({ limitProviders: ['claude'] }, {
    autoStart: false, autoRetry: false, env: {}, claudeWebFetch: mockFetch,
    resolveConfigSnapshot: () => settings
  });
  try {
    for (const [user, labels] of [
      [1, ['Team', 'Team']], [2, ['Pro', 'Team']], [3, ['Max', 'Team', 'Team']],
      [4, ['']], [5, ['Pro', 'Team']], [6, ['Team']]
    ]) {
      const saved = await commands.saveCredential('claude', { claudeWebCookie: `sessionKey=sk-ant-preview-user${user}` });
      assert.equal(saved.verdict, 'valid');
      await runtime.refresh({ provider: 'claude' }, 'credential-save');
      const rows = runtime.getSnapshot().providers;
      assert.deepEqual(rows.map((row) => row.accountLabel), labels);
      assert.equal(new Set(rows.map((row) => row.accountKey)).size, rows.length);
      assert.equal(rows.some((row) => row.accountName === 'Personal Free'), false);
      if (user === 4) assert.deepEqual(rows[0].windows, []);
      if (user === 5) assert.deepEqual(rows.map((row) => row.status), ['ok', 'unavailable']);
    }
    const rejected = await commands.saveCredential('claude', { claudeWebCookie: 'sk-ant-unknown-preview-key' });
    assert.equal(rejected.saved, false);
    assert.equal(rejected.status, 'unauthorized');
    await assert.rejects(mockFetch('https://example.com/'), /only accepts Claude fixture/);
  } finally {
    runtime.stop();
  }
});

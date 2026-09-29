'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PREVIEW_NAME = 'Token Monitor Preview';
const ENV_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'APPDATA', 'LOCALAPPDATA',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
]);

// The preview starts without ambient provider credentials or project .env.
// HOME remains the real OS home; only explicitly owned app data is redirected.
function previewEnvironment(root, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => ENV_KEYS.has(key)));
  return {
    ...env,
    TOKEN_MONITOR_PREVIEW_ROOT: root,
    TOKEN_MONITOR_SHARED_DIR: path.join(root, 'shared'),
    TOKSCALE_CONFIG_DIR: path.join(root, 'tokscale'),
    TOKEN_MONITOR_DEVICE_ID: 'local-preview',
    TOKEN_MONITOR_CLIENTS: '',
    TOKEN_MONITOR_LIMIT_PROVIDERS: '',
    TOKEN_MONITOR_OPENCODE_AMBIENT: '0',
    TOKEN_MONITOR_WSL_SCAN: '0',
    TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED: '0'
  };
}

function previewSettings(settings = {}) {
  // Load the provider only after bootstrap has isolated paths and environment.
  // Use its parser so malformed persisted values cannot enable OAuth fallback.
  const webCookie = settings.claudeWebCookie
    ? require('../shared/providers/claude/limits').claudeWebCookie({}, settings)
    : '';
  return {
    ...settings,
    hubMode: 'local', hubUrl: '', secret: '', hubHostSecret: '',
    deviceId: 'local-preview', clients: '', customScanPaths: {},
    collectionMode: 'interval', projectsEnabled: false, historyEnabled: false,
    sessionUsageArchiveEnabled: false, wslScanEnabled: false,
    limitsEnabled: true,
    // Clearing the Web cookie must never enable the system OAuth/CLI fallback.
    limitProviders: webCookie ? 'claude' : '',
    opencodeAmbientEnabled: false, opencodeLocalLimitsEnabled: false,
    codexManagedAccounts: [], antigravityManagedAccounts: [], mimoManagedAccounts: [],
    opencodeProfiles: {}, openrouterProfiles: {}, thirdPartyProfiles: {},
    codexResetForecastEnabled: false, discordRpcEnabled: false,
    automaticAppUpdates: false, startAtLogin: false, exportAutoEnabled: false,
    windowToggleShortcut: '', edgeDockEnabled: false
  };
}

function initializeLocalPreview(app, env = process.env) {
  const metadata = app.isPackaged
    ? JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).tokenMonitorPreview
    : null;
  const root = app.isPackaged ? metadata?.root : env.TOKEN_MONITOR_PREVIEW_ROOT;
  if (!root) return null;
  if (!path.isAbsolute(root)) throw new Error('Preview requires an absolute runtime directory');
  const directories = {
    userData: path.join(root, 'user-data'),
    sessionData: path.join(root, 'session'),
    logs: path.join(root, 'logs'),
    crashDumps: path.join(root, 'crashes'),
    shared: path.join(root, 'shared'),
    tokscale: path.join(root, 'tokscale')
  };
  for (const directory of [root, ...Object.values(directories)]) {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
      throw new Error(`Preview data directory must not be a symlink: ${directory}`);
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  app.setName(PREVIEW_NAME);
  for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, directories[key]);
  app.setAppLogsPath(directories.logs);
  const isolatedEnv = previewEnvironment(root, env);
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, isolatedEnv);

  const settingsPath = path.join(directories.userData, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(previewSettings({
      language: 'zh-CN', windowBehavior: 'normal', alwaysOnTop: false,
      showTrayIcon: false, hideAppIcon: false, showLimitSource: true,
      lastViewState: { period: 'today', breakdown: 'limits' }
    }), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return { name: PREVIEW_NAME, root, directories };
}

const ALLOWED_CHANNELS = new Set([
  'settings:get', 'settings:update', 'appearance:getBackgroundImage',
  'appearance:chooseBackgroundImage', 'appearance:clearBackgroundImage',
  'appearance:preview', 'appearance:getNativeMaterial',
  'stats:get', 'stats:allTimeSessions', 'stream:status', 'tray:setIcons',
  'hub:getInfo', 'hub:getBuildStatus', 'app:getInfo', 'app:openUserData',
  'app:openExternal', 'clipboard:write', 'tokscale:getStatus', 'appUpdate:getState',
  'dashboard:open', 'dashboard:getHistory'
]);

function previewIpcHandler(channel, handler) {
  // These reads run when the settings UI opens, even for disabled providers.
  const empty = {
    'cursor:status': () => ({ loggedIn: false, accounts: [], linkedCount: 0, managementBlocked: true }),
    'opencode:status': () => ({ profiles: {}, ambient: null, linked: false }),
    'opencode:getProfiles': () => ({ profiles: {}, hasEnvVar: false, hasAmbientKey: false, ambientEnabled: false }),
    'openrouter:getProfiles': () => ({ profiles: {}, hasEnvVar: false }),
    'thirdparty:getProfiles': () => ({ profiles: {}, hasEnvVar: false }),
    'codex:accounts': () => [], 'antigravity:accounts': () => [], 'mimo:accounts': () => []
  };
  if (Object.hasOwn(empty, channel)) return empty[channel];
  if (channel === 'limits:saveCredential' || channel === 'limits:clearCredential') {
    return (event, providerId, ...args) => {
      if (providerId !== 'claude') throw new Error('Preview 仅支持手动配置 Claude Cookie。');
      return handler(event, providerId, ...args);
    };
  }
  if (ALLOWED_CHANNELS.has(channel)) return handler;
  return () => { throw new Error(`Preview 已禁用此操作：${channel}`); };
}

// Keep Electron's original IPC object intact; only this entry point registers
// the restricted handlers. EventEmitter methods stay bound to the real object.
function createPreviewIpc(ipcMain) {
  return new Proxy(ipcMain, {
    get(ipcTarget, key) {
      if (key === 'handle') return (channel, handler) => ipcTarget.handle(channel, previewIpcHandler(channel, handler));
      const value = Reflect.get(ipcTarget, key);
      return typeof value === 'function' ? value.bind(ipcTarget) : value;
    }
  });
}

module.exports = { createPreviewIpc, initializeLocalPreview, previewEnvironment, previewIpcHandler, previewSettings };

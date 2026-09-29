'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadManifest, manifestMode } = require('./vendoredTokscale');
const { previewEnvironment: isolatedPreviewEnvironment } = require('../src/electron/localPreview');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function previewPaths(root = PROJECT_ROOT, { mock = false } = {}) {
  const base = path.join(root, 'tmp', 'local-preview');
  return {
    root,
    base,
    mock,
    runtime: path.join(base, mock ? 'mock-runtime' : 'runtime'),
    npmCache: path.join(base, 'cache', 'npm'),
    electronCache: path.join(base, 'cache', 'electron'),
    builderCache: path.join(base, 'cache', 'electron-builder')
  };
}

function parseOptions(argv) {
  const supported = new Set(['--build', '--prepare', '--check-only', '--help', '--mock']);
  for (const arg of argv) {
    if (!supported.has(arg)) throw new Error(`不支持的参数：${arg}。使用 --help 查看用法。`);
  }
  if (argv.includes('--prepare') && argv.includes('--check-only')) {
    throw new Error('--prepare 会创建目录，不能与只读的 --check-only 同时使用。');
  }
  return {
    build: argv.includes('--build'),
    mock: argv.includes('--mock'),
    prepare: argv.includes('--prepare'),
    checkOnly: argv.includes('--check-only'),
    help: argv.includes('--help')
  };
}

function installedPackage(root, name) {
  const packagePath = path.join(root, 'node_modules', name, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`缺少本项目依赖 ${name}。请先明确执行依赖安装；预览脚本不会自动安装。`, { cause: error });
  }
}

function checkVendoredTokscale(root) {
  const manifest = loadManifest();
  const entry = manifest.platforms['darwin-arm64'];
  if (!entry) throw new Error('tokscale manifest 缺少 darwin-arm64，无法打包预览。');
  const installed = installedPackage(root, entry.package);
  const binary = path.join(root, 'node_modules', entry.package, 'bin', 'tokscale');
  if (!fs.existsSync(binary)) throw new Error(`缺少 tokscale 二进制：${binary}`);
  if (manifestMode(manifest) !== 'override') return;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (installed.version !== manifest.baseVersion || digest !== entry.sha256) {
    throw new Error('本地 tokscale 与项目锁定版本不一致。请先明确执行 npm run ensure:tokscale，再打包；预览脚本不会下载或替换二进制。');
  }
}

function checkDependencies(paths, options = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) {
    throw new Error(`需要 Node.js >=22.15.0，当前为 ${process.versions.node}。`);
  }
  const project = JSON.parse(fs.readFileSync(path.join(paths.root, 'package.json'), 'utf8'));
  const electron = installedPackage(paths.root, 'electron');
  for (const name of Object.keys(project.dependencies || {})) installedPackage(paths.root, name);
  const electronDist = path.join(paths.root, 'node_modules', 'electron', 'dist');
  const relativeExecutable = process.platform === 'darwin'
    ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
    : (process.platform === 'win32' ? 'electron.exe' : 'electron');
  const executable = path.join(electronDist, relativeExecutable);
  if (!fs.existsSync(executable)) {
    throw new Error(`Electron 框架未准备好：${executable}。请先完成 Electron 的显式安装或下载。`);
  }
  if (options.build) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new Error('pack:preview 当前仅支持 macOS arm64 本机打包，避免跨平台下载框架。');
    }
    installedPackage(paths.root, 'electron-builder');
    if (electron.version !== project.devDependencies.electron) {
      throw new Error('已安装 Electron 版本与 package.json 不一致，请先同步本项目依赖。');
    }
    checkVendoredTokscale(paths.root);
  }
  return {
    executable,
    builderCli: path.join(paths.root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
  };
}

function previewEnvironment(paths, inherited = process.env, { build = false } = {}) {
  const env = {
    ...(build ? inherited : isolatedPreviewEnvironment(paths.runtime, inherited)),
    TOKEN_MONITOR_PREVIEW_ROOT: paths.runtime,
    TOKEN_MONITOR_PREVIEW_MOCK: paths.mock ? '1' : '0',
    npm_config_cache: paths.npmCache,
    ELECTRON_CACHE: paths.electronCache,
    ELECTRON_BUILDER_CACHE: paths.builderCache,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false'
  };
  // The preview uses local ad-hoc signing, never a release certificate or Apple account.
  for (const key of [
    'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME',
    'CSC_INSTALLER_LINK', 'CSC_INSTALLER_KEY_PASSWORD', 'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY',
    'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE',
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
    'GL_TOKEN', 'GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN', 'BT_TOKEN', 'KEYGEN_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'
  ]) delete env[key];
  return env;
}

function prepareDirectories(paths) {
  for (const directory of [paths.runtime, paths.npmCache, paths.electronCache, paths.builderCache]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log('用法：node scripts/local-preview.js [--mock] [--build] [--check-only | --prepare]\n默认启动独立预览；--mock 使用离线模拟账号和单独数据目录；--build 仅打包；--check-only 只读检查；--prepare 仅创建预览目录并检查。');
    return 0;
  }
  const paths = previewPaths(PROJECT_ROOT, options);
  console.log(`预览运行数据：${paths.runtime}\n构建缓存：${path.join(paths.base, 'cache')}\n模式：${options.mock ? '离线模拟 Claude Cookie' : '手动配置 Claude Cookie'}；无本机用量扫描。`);
  if (options.prepare) prepareDirectories(paths);
  const dependencies = checkDependencies(paths, options);
  if (options.checkOnly || options.prepare) {
    console.log('预览依赖检查通过；没有启动应用或构建。');
    return 0;
  }
  prepareDirectories(paths);
  const env = previewEnvironment(paths, process.env, { build: options.build });
  let executable = dependencies.executable;
  let args = [paths.root];
  if (options.build) {
    const configPath = path.join(paths.root, 'scripts', 'electron-builder.preview.config.js');
    const config = require(configPath);
    if (!fs.existsSync(dependencies.builderCli)) throw new Error('electron-builder CLI 不完整，请先修复本项目依赖。');
    executable = process.execPath;
    args = [dependencies.builderCli, '--config', configPath, '--mac', '--arm64', '--dir', '--publish', 'never',
      `--config.directories.output=${config.directories.output}`];
    console.log(`构建输出：${config.directories.output}\n仅使用已安装 Electron；不会自动安装依赖或启动构建产物。`);
  }
  const result = spawnSync(executable, args, { cwd: paths.root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`预览进程因 ${result.signal} 结束。`);
  return result.status ?? 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[preview] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkDependencies, checkVendoredTokscale, main, parseOptions, previewEnvironment, previewPaths };

'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const packageJson = require('../package.json');

const root = path.resolve(__dirname, '..');
const mock = process.env.TOKEN_MONITOR_PREVIEW_MOCK === '1';
const productName = mock ? 'Token Monitor Preview Mock' : 'Token Monitor Preview';
const buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;

// Kept separate from the release config so its signing, Widget and publishing
// hooks cannot become part of a local preview as the release setup evolves.
module.exports = {
  extends: null,
  appId: mock ? 'com.javis.tokenmonitor.preview.mock' : 'com.javis.tokenmonitor.preview',
  productName,
  directories: { output: path.join(root, 'dist', 'preview', buildId) },
  electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
  electronVersion: packageJson.devDependencies.electron,
  npmRebuild: false,
  nodeGypRebuild: false,
  forceCodeSigning: false,
  publish: null,
  files: [
    'src/electron/**/*',
    'src/shared/**/*',
    'src/hub/**/*',
    'assets/icon.png',
    'assets/icons/**/*',
    'package.json'
  ],
  asarUnpack: [
    'node_modules/@tokscale/**/*',
    'node_modules/tokscale/**/*',
    'node_modules/koffi/**/*'
  ],
  extraMetadata: {
    name: 'token-monitor-preview',
    productName,
    tokenMonitorPreview: {
      root: path.join(root, 'tmp', 'local-preview', mock ? 'mock-runtime' : 'runtime'),
      mode: mock ? 'mock-claude' : 'manual-claude'
    }
  },
  mac: {
    target: [{ target: 'dir', arch: ['arm64'] }],
    category: 'public.app-category.developer-tools',
    icon: path.join(root, 'assets', 'icon.png'),
    minimumSystemVersion: '12.0',
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    extendInfo: { LSUIElement: true }
  }
};

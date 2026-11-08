'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { stageChineseUi } = require('./stage-locale.cjs');

const root = path.resolve(__dirname, '..');
const [destination, exe, node, python, commit, cargoMetadata] = process.argv.slice(2);
if (!cargoMetadata) throw Error('Usage: stage-tauri DESTINATION EXE NODE_DISTRIBUTION PYTHON_RUNTIME COMMIT CARGO_METADATA');
if (!/^[0-9a-f]{40}(?:\+draft)?$/.test(commit)) throw Error('Build requires the exact source commit');
const packageRoot = path.resolve(destination);
assert.equal(fs.existsSync(packageRoot), false, 'Choose a new candidate directory');
const runtime = path.join(packageRoot, 'desktop', 'runtime');
const source = file => path.join(root, file);
const app = path.join(runtime, 'app');
fs.mkdirSync(app, { recursive: true });
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false,
    filter: file => !/(?:^|[\\/])__pycache__(?:$|[\\/])|\.py[co]$/.test(file) });
};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const out = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const version = require('../package.json').version;
for (const name of ['canvas.js','canvas-worker.py','comfy-inspection.js','desktop-support.js','locale-zh-CN.json','mcp-bridge.js','project.js','tauri-host.cjs','public']) {
  copy(source('app/' + name), path.join(app, name));
}
stageChineseUi(app);
copy(source('demo'), path.join(runtime, 'demo'));
copy(exe, path.join(packageRoot, 'desktop', 'production-canvas.exe'));
copy(path.join(node, 'node.exe'), path.join(packageRoot, 'runtime', 'node', 'node.exe'));
copy(path.join(node, 'LICENSE'), path.join(packageRoot, 'runtime', 'node', 'LICENSE'));
copy(python, path.join(packageRoot, 'runtime', 'python'));

const lock = require('../package-lock.json');
for (const [name, record] of Object.entries(lock.packages)) {
  if (!name.startsWith('node_modules/') || record.dev) continue;
  const dependency = source(name);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dependency, 'package.json'), 'utf8')).version, record.version, name);
  copy(dependency, path.join(runtime, name));
}

for (const file of ['plugin.json', 'mcp.json', 'privacy.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'mcp/server.py', 'mcp/requirements.txt',
  'mcp/README.md', 'docs/project-format.md', 'docs/sample-review.png', 'docs/tauri-candidate.md', 'docs/verification.md',
  'scripts/start-canvas.ps1', 'scripts/start-mcp.ps1', 'assets/icon.png', 'assets/screenshot-1.png', 'skills/production-canvas/SKILL.md']) {
  copy(source(file), path.join(packageRoot, file));
}
copy(source('demo'), path.join(packageRoot, 'sample'));
copy(source('packaging/PLUGIN_THIRD_PARTY_NOTICES.md'), path.join(packageRoot, 'runtime', 'PYTHON-NOTICES.md'));
copy(source('scripts/switch-local-canvas.ps1'), path.join(packageRoot, 'scripts', 'switch-local-canvas.ps1'));

const metadata = JSON.parse(fs.readFileSync(cargoMetadata, 'utf8').replace(/^\uFEFF/, ''));
const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
const notice = [];
for (const item of metadata.packages.filter(pkg => pkg.source && resolved.has(pkg.id))) {
  const directory = path.dirname(item.manifest_path);
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(file => file.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE)([-._]|$)/i.test(file.name))
    .map(file => file.name);
  const names = ['rust-notices', item.name + '-' + item.version];
  for (const file of files) copy(path.join(directory, file), path.join(packageRoot, 'runtime', ...names, file));
  notice.push({ name: item.name, version: item.version, license: item.license, files });
}
out(path.join(packageRoot, 'runtime', 'RUST-NOTICES.json'), notice);
const desktop = path.join(packageRoot, 'desktop', 'production-canvas.exe');
const receipt = {
  version, commit, executableSha256: digest(desktop),
  nodeSha256: digest(path.join(packageRoot, 'runtime', 'node', 'node.exe')),
  pythonSha256: digest(path.join(packageRoot, 'runtime', 'python', 'python.exe')),
  pluginVersion: require('../plugin.json').version
};
out(path.join(runtime, 'build.json'), { version, commit });
out(path.join(packageRoot, 'build-receipt.json'), receipt);
console.log(JSON.stringify(receipt));

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = __dirname;
const source = path.join(root, 'source');
const stage = path.join(root, 'verification', 'build-source');
const output = path.join(root, 'dist', 'english');
const prior = path.resolve(root, '..', 'production-canvas-plugin-submission-v001');
const modules = path.join(prior, 'verification', 'app-source', 'node_modules');
const sourceRequire = require('node:module').createRequire(path.join(source, 'package.json'));
const version = require(path.join(source, 'package.json')).version;
const artifact = path.join(output, 'production-canvas-english-' + version + '-win-x64.exe');
if (fs.existsSync(artifact)) throw Error('A built candidate already exists. Preserve it before another build.');
fs.mkdirSync(stage, { recursive: true });

const fingerprint = createHash('sha256');
fingerprint.update(fs.readFileSync(__filename));
function copy(relative) {
  const entry = path.join(source, relative);
  if (fs.statSync(entry).isDirectory()) {
    for (const name of fs.readdirSync(entry).sort()) copy(path.join(relative, name));
    return;
  }
  if (relative.endsWith('.pyc') || relative.includes('__pycache__')) return;
  const data = fs.readFileSync(entry);
  fingerprint.update(relative.replaceAll('\\', '/') + '\0');
  fingerprint.update(data);
  const target = path.join(stage, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(entry, target);
}
for (const relative of ['app', 'demo', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) copy(relative);
const sourceHash = fingerprint.digest('hex');
const identity = '71fd9835c329b7cfab022822af9b1ce2b1275041+english.' + sourceHash.slice(0, 12);
fs.cpSync(modules, path.join(stage, 'node_modules'), { recursive: true });
const normalized = [];
function normalize(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    if (fs.statSync(file).isDirectory()) { normalize(file); continue; }
    if (!/\.(?:js|cjs|mjs|json|md|txt)$/.test(name)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!/\p{Script=Han}/u.test(text)) continue;
    const result = text.replace(/\p{Script=Han}/gu, character => character.split('')
      .map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
    fs.writeFileSync(file, result);
    normalized.push(path.relative(stage, file).replaceAll('\\', '/'));
  }
}
normalize(path.join(stage, 'node_modules'));

const config = {
  ...JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).build,
  electronVersion: '45.2.1',
  electronDist: path.join(path.dirname(sourceRequire.resolve('electron/package.json')), 'dist'),
  electronLanguages: ['en-US'],
  npmRebuild: false,
  directories: { output },
  artifactName: 'production-canvas-english-${version}-win-x64.exe',
  extraMetadata: { buildCommit: identity },
  nsis: { installerLanguages: ['en_US'], multiLanguageInstaller: false, language: '1033' }
};
const configFile = path.join(root, 'verification', 'english-build-config.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
execFileSync(process.execPath, [sourceRequire.resolve('electron-builder/cli.js'), '--win', 'portable', '--x64',
  '--publish', 'never', '--projectDir', stage, '--config', configFile], { cwd: stage, stdio: 'inherit' });
const receipt = {
  app_version: version,
  base_commit: '71fd9835c329b7cfab022822af9b1ce2b1275041',
  source_content_sha256: sourceHash,
  build_identity: identity,
  artifact: path.relative(root, artifact).replaceAll('\\', '/'),
  artifact_sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),
  source_status: 'Uncommitted isolated English candidate',
  electron_languages: ['en-US'],
  normalized_dependency_sources: normalized,
  publication: 'Not published'
};
fs.writeFileSync(path.join(root, 'verification', 'english-build.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));

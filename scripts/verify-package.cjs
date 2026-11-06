'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
const build = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const env = {
  ...process.env,
  CANVAS_EXECUTABLE: path.join(root, 'dist', 'ProductionCanvas-' + version + '-win-x64.exe'),
  CANVAS_EXPECTED_BUILD: build
};
for (const executable of [env.CANVAS_EXECUTABLE, path.join(root, 'dist', 'win-unpacked', 'Production Canvas.exe')]) {
  execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'verify-windows-icon.ps1'),
    '-Executable', executable, '-ExpectedIcon', path.join(root, 'app', 'public', 'studio-mark.ico')],
  { cwd: root, stdio: 'inherit' });
}
for (const script of ['verify-sample.cjs', 'verify-opening.cjs']) {
  execFileSync(process.execPath, [path.join(__dirname, script)], { cwd: root, env, stdio: 'inherit' });
}

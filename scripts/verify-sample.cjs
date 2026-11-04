'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release', 'sample-verification'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-desktop-test-'));
fs.mkdirSync(output, { recursive: true });
const reportFile = path.join(output, 'result.json');
const executable = process.env.CANVAS_EXECUTABLE || require('electron');
const args = process.env.CANVAS_EXECUTABLE ? [] : [root];
args.push('--profile=' + profile, '--verify=' + reportFile, '--verify-write=isolated-copy',
  '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-renderer-backgrounding');
if (process.env.CANVAS_CAPTURE) args.push('--capture-dir=' + path.join(output, 'screenshots'));

try {
  execFileSync(executable, args, { cwd: root, timeout: 240000, stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (report.error || report.layout.chapters !== 4 || report.layout.placeholders !== 3 ||
      report.layout.tracks[0].clips !== 16 || !report.checkpoints.note?.persisted ||
      report.checkpoints.displayedFrames?.scanned !== 720 || report.checkpoints.displayedFrames?.randomPauses !== 30) {
    throw Error('Incomplete sample verification: ' + JSON.stringify(report));
  }
  console.log(JSON.stringify({ result: 'passed', version: report.version, buildCommit: report.buildCommit, profile,
    reportFile, displayedFrames: report.checkpoints.displayedFrames, shortcuts: report.checkpoints.shortcuts }, null, 2));
} catch (error) {
  if (error.stderr) console.error(error.stderr.toString());
  if (fs.existsSync(reportFile)) console.error(fs.readFileSync(reportFile, 'utf8'));
  console.error(error.message);
  process.exitCode = 1;
}

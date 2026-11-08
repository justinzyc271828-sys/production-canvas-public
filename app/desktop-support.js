'use strict';

const fs = require('node:fs');
const path = require('node:path');

function initializeDemo(data, resources, settings, titles = {}) {
  const previous = path.join(data, 'sample-project-illustrated');
  if (fs.existsSync(path.join(previous, 'current-manifest.json'))) {
    settings.projects['demo-v1'] = { title: titles.earlier || 'Earlier sample and annotations', root: previous, manifest: 'current-manifest.json', demo: true };
  }
  const root = path.join(data, 'sample-project-v2');
  if (!fs.existsSync(path.join(root, 'project.json'))) {
    const stage = fs.mkdtempSync(path.join(data, 'sample-staging-'));
    fs.cpSync(path.join(resources, 'demo'), stage, { recursive: true });
    fs.renameSync(stage, root);
  }
  return { title: titles.sample || 'Frame Annotation Lab', root, manifest: 'project.json', demo: true };
}

function localTools(document) {
  const tools = {};
  if (typeof document.python === 'string' && path.isAbsolute(document.python)) tools.python = document.python;
  for (const name of ['kdenlive', 'comfy']) {
    const tool = document[name];
    if (!tool || typeof tool.command !== 'string' || !path.isAbsolute(tool.command)) continue;
    const entry = { command: tool.command };
    if (tool.cwd && path.isAbsolute(tool.cwd)) entry.cwd = tool.cwd;
    if (Array.isArray(tool.args) && tool.args.every(arg => typeof arg === 'string')) entry.args = tool.args;
    if (name === 'comfy') {
      const keys = ['COMFY_BIN', 'COMFY_NO_TELEMETRY', 'DO_NOT_TRACK', 'PYTHONUTF8', 'PYTHONIOENCODING'];
      entry.env = Object.fromEntries(keys.filter(key => typeof tool.env?.[key] === 'string').map(key => [key, tool.env[key]]));
      entry.env.COMFY_LOCAL_URL = 'http://127.0.0.1:8188';
    }
    tools[name] = entry;
  }
  return tools;
}

module.exports = { initializeDemo, localTools };

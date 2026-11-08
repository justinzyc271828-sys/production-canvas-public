'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { launch, command, connect, stop, until, cleanScratch } = require('./desktop-probe.cjs');

const [executable, toolConfig, output = 'release/tauri-integrations.json', fixtureParent = os.tmpdir()] = process.argv.slice(2);
if (!executable || !toolConfig) throw Error('Usage: verify-tauri-integrations EXE LOCAL_TOOL_CONFIG [OUTPUT_JSON] [KDENLIVE_ALLOWED_DIRECTORY]');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const root = fs.mkdtempSync(path.join(fs.realpathSync(fixtureParent), 'canvas-pilot-integrations-'));
const project = path.join(root, 'synthetic-film');
const profile = path.join(root, 'profile');
const graph = { id: 'canvas-integration-fixture', revision: 17, nodes: [{ id: 1 }, { id: 2 }] };
const recorded = { posts: 0, outside: 0, report: null };
const servers = [];

async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

function buildProject(tools) {
  fs.cpSync(path.join(__dirname, '..', 'demo'), project, { recursive: true });
  fs.mkdirSync(profile);
  const manifestPath = path.join(project, 'project.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const timeline = 'edit/sample.kdenlive-cli.json';
  const timelinePath = path.join(project, timeline);
  const timelineData = JSON.parse(fs.readFileSync(timelinePath));
  for (const clip of timelineData.bin) clip.source = path.resolve(project, clip.source);
  write(timelinePath, timelineData);
  const reviewPath = path.join(project, manifest.review);
  const review = JSON.parse(fs.readFileSync(reviewPath));
  review.timelineRevision = hash(timelinePath);
  write(reviewPath, review);
  manifest.timeline = timeline;
  manifest.comfy = { path: 'workspace.json', canvas_id: graph.id };
  manifest.notes = 'sample-storyboard.md';
  write(manifestPath, manifest);
  write(path.join(project, 'workspace.json'), graph);
  write(path.join(profile, 'canvas-settings.json'), {
    active: 'fixture', tools: { kdenlive: tools.kdenlive },
    projects: { fixture: { root: project, manifest: 'project.json' } }
  });
  return { timelinePath, original: hash(timelinePath) };
}

async function verify() {
  const sourceConfig = JSON.parse(fs.readFileSync(toolConfig, 'utf8').replace(/^\uFEFF/, ''));
  const tools = sourceConfig.tools || sourceConfig;
  assert.ok(fs.existsSync(tools.kdenlive.command), 'Use a configured local Kdenlive adapter');
  const { timelinePath, original } = buildProject(tools);
  const outside = await serve((_, response) => { recorded.outside++; response.end('unexpected'); });
  const comfy = await serve((request, response) => {
    if (request.headers['x-canvas-desktop']) throw Error('Canvas desktop token escaped the review origin');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      recorded.posts++;
      response.writeHead(200).end('unexpected');
    } else if (request.url.startsWith('/api/userdata/')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(graph));
    } else if (request.url.startsWith('/observe?')) {
      recorded.report = Object.fromEntries(new URL(request.url, comfy).searchParams);
      response.end('ok');
    } else if (request.url === '/workspace.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' }).end(
        'window.comfyAPI = { app: { app: { canvas: {}, rootGraph: {}, async loadGraphData(graph) {' +
        'this.rootGraph = { id: graph.id, _nodes: graph.nodes, getNodeById: () => null };' +
        'const status = await fetch("/mutate", {method:"POST", body:"synthetic"}).then(r=>r.status);' +
        'const external = await fetch(' + JSON.stringify(outside + '/unexpected') + ').then(r=>r.status).catch(()=>"blocked");' +
        'await fetch("/observe?write=" + status + "&external=" + external);' +
        '} } } };'
      );
    } else if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><script src="/workspace.js"></script><h1>ComfyUI inspection fixture</h1>');
    } else response.writeHead(404).end();
  });
  const app = await launch({ kind: 'rust', executable: path.resolve(executable), profile, language: 'zh-CN',
    environment: { CANVAS_COMFY_INSPECTION_ORIGIN: comfy, CANVAS_NODE: path.join(root, 'missing-node.exe') } });
  let page, storyboard;
  try {
    const state = await until(async () => {
      const row = await command(app, 'state');
      return row.ready ? row : null;
    });
    page = await connect(app);
    const locale = await page.evaluate(() => ({
      lang: document.documentElement.lang, title: document.title,
      tool: model.canEdit, graph: model.comfyCanvas, storyboard: model.hasStoryboard
    }));
    assert.equal(locale.lang, 'zh-CN');
    assert.equal(locale.title, '制作画布');
    assert.equal(locale.tool, true);
    assert.equal(locale.graph, true);
    assert.equal(locale.storyboard, true);

    const storyboardAddress = await page.evaluate(() => {
      const link = document.querySelector('#storyboard');
      const address = link.href;
      link.click();
      return address;
    });
    storyboard = await connect(app, url => url === storyboardAddress);
    const text = await storyboard.evaluate(() => document.body.textContent);
    assert.ok(text.includes(fs.readFileSync(path.join(project, 'sample-storyboard.md'), 'utf8').trim().slice(0, 20)));

    const panel = await page.evaluate(async () => {
      await toggleComfy(true);
      return { mode: document.body.dataset.view, status: document.querySelector('#graph-info').textContent };
    }, [], 50000);
    assert.equal(panel.mode, 'comfy', panel.status);
    assert.equal(recorded.posts, 0);
    assert.equal(recorded.outside, 0);
    assert.deepEqual(recorded.report, { write: '403', external: 'blocked' });
    const returned = await page.evaluate(async () => {
      await toggleComfy(false);
      return { mode: document.body.dataset.view, frame: playFrame() };
    });
    assert.deepEqual(returned, { mode: 'review', frame: state.displayed_frame });

    const queued = await page.evaluate(async () => {
      const track = model.tracks.find(track => track.type === 'video');
      const clip = track.clips[0];
      return request(api('/edits'), { revision: model.revision, track: track.id, clip: clip.index,
        operation: 'trim', start: clip.start, end: clip.end - 1 });
    });
    const receipt = await until(async () => {
      const job = await page.evaluate(id => request(api('/jobs/' + id)), [queued.id]);
      return ['completed', 'failed', 'attention'].includes(job.status) ? job : null;
    }, 210000, 1200);
    assert.equal(receipt.status, 'completed', receipt.error || 'Kdenlive did not complete');
    const run = path.join(project, '.production-canvas', 'runs', queued.id);
    const preview = path.join(run, 'preview.mp4');
    assert.equal(hash(preview), receipt.preview_sha256);
    assert.equal(hash(timelinePath), original);
    const draft = await page.evaluate(async id => {
      await openDraft(id);
      await mcpWaitForFrame(0, projectEpoch);
      return { active: draft, version: versionName(), digest: mcpReviewState().video_sha256, url: player.src };
    }, [queued.id]);
    assert.equal(draft.active, queued.id);
    assert.equal(draft.version, queued.id);
    assert.equal(draft.digest, receipt.preview_sha256);
    assert.equal(new URL(draft.url).searchParams.get('draft'), queued.id);
    return { localizedWindow: locale.lang, storyboard: true,
      comfy: { readOnlyRequests: true, verifiedNodes: graph.nodes.length, rejectedWriteStatus: 403, returnedToFrame: returned.frame },
      kdenlive: { worker: 'bundled Python; configured local adapter', verifiedPreviewSha256: receipt.preview_sha256,
        previewBytes: fs.statSync(preview).size, untouchedInputTimeline: true, draftOpened: true } };
  } finally {
    storyboard?.close();
    page?.close();
    await stop(app);
  }
}

verify().then(report => {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  write(path.resolve(output), report);
  console.log(JSON.stringify(report));
  try { cleanScratch(root, fixtureParent); } catch (error) { console.log('Temporary test files retained: ' + error.code); }
}).catch(error => {
  console.error(error.stack + '\nIsolated diagnostic files: ' + root);
  process.exitCode = 1;
}).finally(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

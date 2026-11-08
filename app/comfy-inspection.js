'use strict';

const comfyOrigin = 'http://127.0.0.1:8188';

async function readGraph(record, origin = comfyOrigin) {
  const url = origin + '/api/userdata/' + encodeURIComponent('workflows/' + record.filename);
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' }).catch(() => {
    throw new Error('Local ComfyUI is unavailable. Start it and try again.');
  });
  if (!response.ok) throw new Error('The project workspace was not found in ComfyUI');
  const graph = await response.json().catch(() => {
    throw new Error('Local ComfyUI could not read the workflow. Check the service and try again.');
  });
  if (graph.id !== record.id || !Array.isArray(graph.nodes)) throw new Error('The ComfyUI workspace does not match the project manifest');
  return graph;
}

function centerNodeScript(node) {
  if (!Number.isSafeInteger(node) || node < 1) return;
  const source = function (id) {
    const app = window.comfyAPI?.app?.app;
    const target = app?.rootGraph?.getNodeById(id);
    const canvas = app?.canvas;
    if (!target || !canvas) return;
    if (typeof canvas.centerOnNode === 'function') canvas.centerOnNode(target);
    else if (canvas.ds) {
      canvas.ds.offset[0] = canvas.canvas.width / (2 * canvas.ds.scale) - target.pos[0] - target.size[0] / 2;
      canvas.ds.offset[1] = canvas.canvas.height / (2 * canvas.ds.scale) - target.pos[1] - target.size[1] / 2;
      canvas.setDirty(true, true);
    }
  };
  return '(' + source.toString() + ')(' + node + ')';
}

function loadGraphScript(graph) {
  return `(async () => {
      const wait = () => new Promise(resolve => setTimeout(resolve, 150));
      const until = Date.now() + 18000;
      let app;
      while (Date.now() < until) {
        app = window.comfyAPI?.app?.app;
        if (app?.canvas && app.rootGraph && typeof app.loadGraphData === 'function' &&
          !document.getElementById('splash-loader')?.getClientRects().length) break;
        await wait();
      }
      if (!app?.canvas || document.getElementById('splash-loader')?.getClientRects().length) {
        throw Error('ComfyUI workspace load timed out');
      }
      const graph = ${JSON.stringify(graph)};
      await app.loadGraphData(graph);
      return { id: app.rootGraph.id, nodes: app.rootGraph._nodes.length };
    })()`;
}

module.exports = { comfyOrigin, readGraph, centerNodeScript, loadGraphScript };

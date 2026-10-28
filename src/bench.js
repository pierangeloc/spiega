/* ============================================================
   handwave bench — the same explanation, drawn by several models.

   The question this answers is not "can the model emit valid JSON" but
   "does the model draw a board worth looking at": does it label its arrows,
   does it reach past `service` for the kinds that carry meaning, does it lay
   out a flow, does it know when to stop adding boxes.

   Models are driven through `opencode run -m provider/model`, so every
   provider you have already authenticated is available with one code path.
   The model emits ops as text; we parse, apply and render. Nothing here
   touches a live board, so runs are isolated and can go in parallel.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { emptyBoard, applyOps } from './board/state.js';
import { snapshotHTML } from './board/snapshot.js';
import { renderSVG } from './render/render.js';
import { KINDS } from './render/glyphs.js';
import { PAPER, PANEL, INK, MUTED, RULE, ACCENT, MONO, paperTexture } from './render/theme.js';

export const BRIEF = `You are explaining a software system at a whiteboard.

Reply with your explanation in prose, and interleave board operations as JSON
objects, each alone on its own line, exactly where that part of the explanation
happens. Draw as you talk: a sentence, then the op for the thing it is about.

  {"op":"title","text":"Placing an order"}
  {"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn"}
  {"op":"edge","from":"gw","to":"orders","label":"gRPC","async":false}
  {"op":"note","label":"retries capped at 3"}
  {"op":"boundary","label":"our VPC","members":["gw","orders"]}
  {"op":"step","edge":"gw>orders","step":"The gateway forwards the call"}
  {"op":"say","text":"The gateway does authn, then hands off."}

kind is one of: ${KINDS.join(' ')}
  client=a browser or caller, gateway=gateway/LB/ingress, service=a service,
  compute=a worker pool (replicas:N), datastore=a database, cache=a cache,
  queue=a topic or queue, external=a third party, note=your own handwriting.

Rules:
- Every edge gets a label saying what travels on it.
- Give each node an id and refer to it in edges. Layout is automatic: a node
  sits one column right of whatever points at it. Never position anything.
- sub is for what changes the design ("3 replicas", "idempotency"), not a
  restatement of the label.
- Add {"op":"step",...} entries for the order things happen in, if order matters.
- Eight or ten boxes is a board someone can hold in their head. Twenty is a map.
  Draw the part under discussion, not the whole system.`;

/* ---------- pull ops out of whatever the model said ---------- */

/* Scans for balanced top-level JSON objects and keeps the ones with an "op".
   This survives code fences, prose around the JSON, and objects spread over
   several lines, which models do in roughly equal measure. */
export function extractOps(text) {
  const ops = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length && j < i + 20000; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) { end = j; break; } }
    }
    if (end < 0) continue;
    try {
      const o = JSON.parse(s.slice(i, end + 1));
      if (o && typeof o === 'object' && typeof o.op === 'string') ops.push(o);
    } catch { /* not JSON; move on */ }
    i = end;
  }
  return ops;
}

/* ---------- what makes a board good ---------- */

export function score(board) {
  const edges = board.edges || [];
  const nodes = board.nodes || [];
  const labelled = edges.filter(e => e.label).length;
  const kinds = new Set(nodes.map(n => n.kind));
  const ided = edges.filter(e =>
    nodes.some(n => n.id === e.from) && nodes.some(n => n.id === e.to)).length;
  return {
    boxes: nodes.length,
    lines: edges.length,
    steps: (board.flow || []).length,
    said: (board.transcript || []).length,
    notes: nodes.filter(n => n.kind === 'note').length,
    boundaries: (board.boundaries || []).length,
    titled: !!board.title,
    labelled_edges: edges.length ? Math.round((labelled / edges.length) * 100) : 0,
    connected_edges: edges.length ? Math.round((ided / edges.length) * 100) : 0,
    kinds_used: kinds.size,
    subs: nodes.filter(n => n.sub).length,
  };
}

/* ---------- running one model ---------- */

const stripAnsi = s => String(s).replace(/\u001b\[[0-9;]*m/g, '');

/* The models you can actually reach right now. On a metered provider this
   changes between calls, so it is worth asking rather than remembering. */
export function listModels() {
  return new Promise(resolve => {
    const child = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(out.split('\n').map(s => s.trim()).filter(Boolean)));
  });
}

function runModel(model, prompt, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn('opencode', ['run', '-m', model, '--log-level', 'none', prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', e => {
      clearTimeout(killer);
      resolve({ out: '', err: e.message, ms: Date.now() - started, failed: true });
    });
    child.on('close', code => {
      clearTimeout(killer);
      resolve({ out, err, code, ms: Date.now() - started, failed: code !== 0 && !out });
    });
  });
}

/* ---------- the comparison page ---------- */

function indexHTML(prompt, results) {
  const cols = ['boxes', 'lines', 'steps', 'labelled_edges', 'connected_edges', 'kinds_used', 'subs', 'notes', 'said'];
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const best = {};
  for (const c of cols) best[c] = Math.max(...results.filter(r => r.ok).map(r => r.score[c] ?? 0));

  const cards = results.map(r => {
    if (!r.ok) {
      return `<section class="card bad"><h2>${esc(r.model)}</h2>
        <p class="err">${esc(r.error || 'produced no ops')}</p></section>`;
    }
    return `<section class="card">
      <h2>${esc(r.model)} <span class="t">${(r.ms / 1000).toFixed(1)}s</span></h2>
      <div class="board">${r.svg}</div>
      <dl>${cols.map(c =>
        `<div${r.score[c] === best[c] && best[c] > 0 ? ' class="top"' : ''}><dt>${c.replace(/_/g, ' ')}</dt><dd>${r.score[c]}</dd></div>`).join('')}</dl>
      <p class="files"><a href="${esc(r.file)}">board</a> · <a href="${esc(r.raw)}">raw reply</a></p>
    </section>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>handwave bench</title><style>
  body{margin:0;background:${PAPER};background-image:${paperTexture};color:${INK};
    font:13px/1.6 ${MONO};padding:30px 22px 70px}
  .wrap{max-width:1400px;margin:0 auto}
  h1{font-size:18px;text-transform:uppercase;letter-spacing:.03em;margin:0 0 4px}
  .prompt{color:${MUTED};margin:0 0 26px;font-size:13px}
  .card{background:${PANEL};border:1.5px solid ${INK};border-radius:16px;box-shadow:5px 5px 0 ${INK};
    padding:14px 16px;margin:0 0 22px}
  .card.bad{box-shadow:5px 5px 0 ${RULE};opacity:.75}
  h2{font-size:14px;margin:0 0 10px;letter-spacing:.03em}
  h2 .t{color:${MUTED};font-weight:400;font-size:12px;margin-left:8px}
  .board{overflow:auto;border:1px solid ${RULE};border-radius:11px;background:${PAPER};padding:6px}
  .board svg{display:block;margin:0 auto;max-width:100%;height:auto}
  dl{display:flex;flex-wrap:wrap;gap:7px;margin:13px 0 9px}
  dl>div{border:1.4px solid ${RULE};border-radius:9px;padding:4px 9px;display:flex;gap:7px;align-items:baseline}
  dl>div.top{border-color:${INK};box-shadow:2px 2px 0 ${ACCENT}}
  dt{color:${MUTED};font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;margin:0}
  dd{margin:0;font-weight:700}
  .files a{color:${MUTED}} .err{color:${MUTED}}
  .files{font-size:11.5px;margin:0}
</style></head><body><div class="wrap">
  <h1>handwave bench</h1>
  <p class="prompt">${esc(prompt)}</p>
  ${cards}
</div></body></html>`;
}

/* ---------- the command ---------- */

export async function bench(prompt, { models = [], out = 'bench', timeout = 180 } = {}) {
  if (!models.length) {
    console.error('handwave bench: --models is required, e.g.\n' +
      '  --models github-copilot/claude-opus-5,github-copilot/gpt-6-sol\n' +
      'Run `opencode models` to see what you have.');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const full = `${BRIEF}\n\n---\n\nNow: ${prompt}`;

  console.log(`asking ${models.length} model${models.length > 1 ? 's' : ''} to explain:\n  ${prompt}\n`);

  const results = await Promise.all(models.map(async model => {
    const slug = model.replace(/[^a-zA-Z0-9.]+/g, '-');
    const r = await runModel(model, full, timeout * 1000);
    const raw = path.join(out, `${slug}.txt`);
    fs.writeFileSync(raw, r.out + (r.err ? `\n\n--- stderr ---\n${r.err}` : ''));

    const ops = extractOps(r.out);
    if (!ops.length) {
      // Distinguish "the model answered but drew nothing" from "the run never
      // happened" — on a metered provider the second is common and is not a
      // fact about the model.
      const why = r.out.trim()
        ? 'answered, but emitted no ops'
        : stripAnsi(r.err).split('\n').map(l => l.trim()).filter(Boolean)[0]
          || `no output (exit ${r.code})`;
      console.log(`  --  ${model}  ${why}  (${(r.ms / 1000).toFixed(1)}s)`);
      return { model, ok: false, ms: r.ms, raw: path.basename(raw), error: why };
    }
    const board = emptyBoard();
    applyOps(board, ops);
    if (!board.title) board.title = prompt.slice(0, 70);
    const file = path.join(out, `${slug}.html`);
    fs.writeFileSync(file, snapshotHTML(board));
    const s = score(board);
    console.log(`  ok  ${model}  ${s.boxes} boxes, ${s.lines} lines, ${s.steps} steps, ` +
      `${s.labelled_edges}% labelled  (${(r.ms / 1000).toFixed(1)}s)`);
    return {
      model, ok: true, ms: r.ms, score: s, board,
      svg: renderSVG(board, { margin: 14, hand: false }).svg,
      file: path.basename(file), raw: path.basename(raw),
    };
  }));

  const index = path.join(out, 'index.html');
  fs.writeFileSync(index, indexHTML(prompt, results));
  console.log(`\n${path.resolve(index)}`);
  return results;
}

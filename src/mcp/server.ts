#!/usr/bin/env node
/* ============================================================
   spiega MCP server — the board as tools, for any MCP client.

   Newline-delimited JSON-RPC over stdio, no dependencies. Every tool is a thin
   wrapper over the same HTTP board the CLI drives, so an agent on MCP and a
   human in a terminal can draw on one board at the same time.
   ============================================================ */

import path from 'node:path';
import { resolveBoard, claimSession } from '../board/server.js';
import type { Board } from '../board/state.js';

/* This process is the conversation, and it has to say so before anything
   resolves a board. The environment says otherwise: opencode starts every MCP
   server from one long-lived daemon, so four sessions read the same pane id
   and were handed the same board — see claimSession in board/server.js. */
claimSession();

const KINDS = 'client, gateway, service, compute, datastore, cache, queue, external, note, formula, blob, vessel, particle, source';

/* The board for this session, started if need be. One server holds every
   board, so this is usually a file read and nothing more. */
const url = async (): Promise<string> => {
  const u = await resolveBoard();
  if (!u) throw new Error('could not start a board');
  return u;
};

/* What POST /op answers, as far as this reads it. */
interface OpReply {
  errors?: string[];
  warnings?: string[];
  nodes?: number;
  edges?: number;
  steps?: number;
  amended?: { chapter: number, title?: string, nodes: number, edges: number, steps: number };
  audit?: { lines?: string[] } | null;
}

async function send(ops: unknown, { audit = false }: { audit?: boolean } = {}): Promise<string> {
  const u = await url();
  const r = await fetch(u + '/op', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ops: ([] as unknown[]).concat(ops), ...(audit ? { audit: true } : {}) }),
  });
  const b: OpReply = await r.json();
  if (b.errors?.length) throw new Error(b.errors.join('; '));
  /* The counts are the whole of what an agent learns about what it just drew,
     so anything the board could not draw properly has to arrive in the same
     breath. It is not an error — the box is on the board — and throwing would
     stop an explanation over a wrong outline.

     Counts first, because that is what is read when all is well. Then the
     warnings, then what the drawing came out like (#56): the counts say the
     ops were accepted, and only the audit says anything about the picture. */
  const a = b.amended;
  const summary = a
    ? `${u} — chapter ${a.chapter} "${a.title || 'untitled'}": ${a.nodes} boxes, ${a.edges} lines, ${a.steps} steps`
    : `${u} — ${b.nodes} boxes, ${b.edges} lines, ${b.steps} steps`;
  return [summary, ...(b.warnings || []), ...(b.audit?.lines || [])].join('\n');
}

/* ---------- tools ---------- */

const TOOLS = [
  {
    name: 'board_say',
    description:
      'Put a line of your explanation on the board\'s transcript, beside the drawing. ' +
      'Use it the way you would talk while drawing: one short sentence at a time, as you draw the thing it is about. ' +
      'Supports **bold** and `code`.\n' +
      'If the line explains one step of the flow, pass `step` (the number as it appears on the board). ' +
      'The transcript then lights that line when that step is lit, and the rest of the script recedes \u2014 ' +
      'so walking 1/6 to 6/6 moves the reader through the words and the picture together. ' +
      'Tag every line that is about a single step; leave opening and closing remarks untagged, since those are ' +
      'about the whole board. Untagged scripts do not highlight at all, so this is the difference between a ' +
      'board someone can follow and one they have to decode.',
    inputSchema: {
      type: 'object', required: ['text'],
      properties: {
        text: { type: 'string', description: 'One sentence. Keep it short.' },
        step: { type: 'integer', description:
          'The step this line explains, numbered as it appears on the board. Pass it whenever the line ' +
          'is about one hop of the flow: the transcript then lights that line when that step is lit, ' +
          'so the reader sees which words go with which part of the picture.' },
        edge: { type: 'string', description:
          'Instead of `step`, the hop itself, e.g. "gw>orders" — survives steps being added or reordered.' },
      },
    },
  },
  {
    name: 'board_draw',
    description:
      'Add things to the board. Pass one op or several. Ops:\n' +
      `  {"op":"node","id":"gw","kind":"gateway","label":"API Gateway","sub":"authn"}   kinds: ${KINDS}\n` +
      '  {"op":"edge","from":"gw","to":"orders","label":"gRPC","async":false}\n' +
      '  {"op":"note","label":"retries are capped at 3"}\n' +
      '  {"op":"node","kind":"formula","id":"ke","label":"K = \\\\int_0^v v\\\\,d(\\\\gamma m v)"}\n' +
      '  {"op":"boundary","label":"our VPC","members":["gw","orders"]}\n' +
      '  {"op":"step","edge":"gw>orders","step":"The gateway forwards the call"}\n' +
      '  {"op":"say","text":"The gateway checks the token first.","step":2}   step: the line explains that step\n' +
      '  {"op":"tag","match":"Flyway V25","step":6}   ties a line said earlier; step:null unties it\n' +
      '  {"op":"title","text":"Placing an order"}\n' +
      'A formula label is a LaTeX subset — superscripts, \\frac, \\sqrt, \\vec, Greek, the usual operators — written bare: ' +
      'there are no delimiters, so $...$ or \\(...\\) around it is drawn as the dollars and brackets you typed. ' +
      'Spacing is derived as in LaTeX, so a+b and a + b set the same way.\n' +
      'Columns are derived from the edges, so draw a node and then the edge into it and it lands in the right place. ' +
      'Draw a few things at a time as you explain them — not the whole diagram in one call.\n' +
      'The reply says what the drawing came out like, since you cannot see it: a line such as ' +
      '"2 arrows cross a box that is not an end of it" means the picture is crowded, not that an op failed. ' +
      'It is about the next thing you draw, not the last one — stop adding to this board and tell the person, ' +
      'who is the one looking at it. Redrawing the same ops cannot help, since layout is derived and the same ' +
      'board gives the same picture; drawing a different board (one fewer note, a shorter label) can.',
    inputSchema: {
      type: 'object', required: ['ops'],
      properties: {
        ops: {
          description: 'One op object, or an array of them.',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
      },
    },
  },
  {
    name: 'board_step',
    description:
      'Light up one step of the flow on the board: its line turns orange, both ends get a halo, ' +
      'everything else dims, and the lines of the script tagged with this step light with it. ' +
      'Walk these in time with what you are saying, and pass `step` to board_say so the words follow. ' +
      'Omit `step` to clear the highlight.',
    inputSchema: {
      type: 'object',
      properties: { step: { type: 'integer', description: 'Step number, counting from 1.' } },
    },
  },
  {
    name: 'board_tag',
    description:
      'Tie a line already on the transcript to a step of the flow, so walking that step lights those words. ' +
      'Use it when you said something before the flow existed, when you tagged a line wrongly, or when someone ' +
      'asks why the script does not light up. Name the line by `match` (a few of its words) or by `line` ' +
      '(counting from 1). Pass several at once to tag a whole explanation after the fact. ' +
      '`step: null` unties a line, which is right for an opening or closing remark \u2014 those are about the ' +
      'whole board and should never dim.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          description: 'One or more { match | line, step | edge } objects.',
          items: {
            type: 'object',
            properties: {
              match: { type: 'string', description: 'A distinctive phrase from the line.' },
              line: { type: 'integer', description: 'The line number, counting from 1.' },
              step: { type: ['integer', 'null'], description: 'The step number as shown on the board; null unties.' },
              edge: { type: 'string', description: 'Or the hop itself, e.g. "gw>orders".' },
            },
          },
        },
      },
      required: ['tags'],
    },
  },
  {
    name: 'board_script',
    description:
      'Read back the transcript as the board holds it: every line, numbered, with the step it is tied to. ' +
      'Call it before tagging, to see what is there and what is still loose.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board_settle',
    description:
      'Finish the explanation: tidy ranks and in-column order once, then freeze the positions. ' +
      'Call when you hand the board to the person, not between draw batches. ' +
      'Snapshot, narration and replay also settle a board that has not been settled yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board_replay',
    description:
      'Play the board back as a movie: every line and box in the order it arrived, with the camera ' +
      'following the work and each spoken line captioned over the drawing. The board keeps its own log, ' +
      'so this costs nothing and needs no ops \u2014 never re-draw an explanation to show it again. ' +
      'Offer it when a long explanation is finished, or whenever someone asks to see it once more.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'board_chapter',
    description:
      'Start the next chapter of this explanation. What is on the board is set aside whole — it keeps its ' +
      'drawing, its script and its steps, and the person can walk back to it — and you get a clean surface ' +
      'under the same title.\n' +
      'Use it when the subject moves on within one explanation: the second system, the next topic, the part ' +
      'after this one. Use it rather than board_clear, which destroys what is on screen and is for a new ' +
      'explanation altogether. Also reach for it when a board is getting full: the board tells you when the ' +
      'drawing is crowded, and a chapter is where the rest of it goes.\n' +
      'Call it before drawing the first chapter too, to name it. Ops land in the current chapter; to add to or ' +
      'correct a chapter you have already left, aim at it with board_amend.',
    inputSchema: {
      type: 'object', required: ['title'],
      properties: { title: { type: 'string', description: 'What this chapter is about. Short — it rides a tab.' } },
    },
  },
  {
    name: 'board_amend',
    description:
      'Add to a chapter you have already left, or correct it — the box you forgot, a label that was wrong, ' +
      'one more line of script. Takes the same ops as board_draw, aimed at one chapter by its number on the ' +
      'strip or by its title.\n' +
      'What is being drawn now is untouched, and so is anyone reading it: the amendment lands in that chapter ' +
      'and nowhere else, and the tab marks itself so the person can see something changed back there. ' +
      'Say out loud that you have done it — a board the reader is not looking at changing quietly is worse ' +
      'than saying "I have added X to chapter 2".\n' +
      'Drawing the same id again corrects it, so a fix is the op again with the right fields. ' +
      'Ids are per chapter: the ids in this chapter are its own.',
    inputSchema: {
      type: 'object', required: ['chapter', 'ops'],
      properties: {
        chapter: {
          description: 'Which chapter: its number on the strip, counting from 1, or its exact title.',
          oneOf: [{ type: 'integer' }, { type: 'string' }],
        },
        ops: {
          description: 'One op object, or an array of them, as board_draw takes.',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
      },
    },
  },
  {
    name: 'board_clear',
    description: 'Wipe the board and start a new explanation. For the next part of the same one, use board_chapter.',
    inputSchema: {
      type: 'object',
      properties: { keepTitle: { type: 'boolean', description: 'Keep the current title.' } },
    },
  },
  {
    name: 'board_snapshot',
    description:
      'Save the board as one standalone HTML file — the drawing, the transcript and the numbered steps, ' +
      'no server needed. Use it when the explanation is finished and worth keeping.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Where to write it. Default ./board.html' } },
    },
  },
  {
    name: 'board_open',
    description:
      'Give the board a window of its own — chromeless, no tabs — and return its URL. ' +
      'Call this once, early, so the person can see what you are drawing. Starts a board if none is running.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'boolean', description: 'An ordinary browser tab instead of its own window.' },
        size: { type: 'string', description: 'Window size, e.g. "1200x900".' },
      },
    },
  },
  {
    name: 'board_url',
    description: 'The URL of the running board, without opening anything. Starts one if none is running.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* An argument that is documented as "one of these, or an array of them".

   Clients do not agree on how to put a non-scalar on the wire: some send the
   array the schema asks for, others serialize it and send a JSON string. The
   string form used to be wrapped whole into a one-element array, so the board
   was handed a single "op" that was a string — `op.op` undefined — and said
   `unknown op "undefined"`, which reads as if the vocabulary were wrong rather
   than the encoding. That made the array form fail in the one place it is
   documented, and the error pointed nowhere near the cause.

   A string that is not JSON gets named here for the same reason: by the time
   it reaches applyOps there is nothing left to say about it. */
const listArg = (value: unknown, what: string): unknown[] => {
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (e) {
      throw new Error(
        `${what} arrived as a string, and it is not valid JSON: ${(e as Error).message}. ` +
        `Pass ${what} as an object or an array of objects, or as a JSON string of one.`);
    }
    return ([] as unknown[]).concat(parsed);
  }
  return ([] as unknown[]).concat(value);
};

/* The arguments the tool schemas above advertise. A client is taken at the
   schema's word, as it always was: what is not a string where one is asked for
   fails inside the call and comes back as that tool's error. */
interface Args {
  text?: string;
  step?: number | null;
  edge?: string;
  ops?: unknown;
  tags?: unknown;
  title?: string;
  chapter?: number | string;
  keepTitle?: boolean;
  path?: string;
  tab?: boolean;
  size?: string;
}

async function call(name: string | undefined, args: Args = {}): Promise<string> {
  switch (name) {
    case 'board_say': {
      const op: { op: 'say', text: string, step?: number, edge?: string } = { op: 'say', text: String(args.text ?? '') };
      if (args.step != null) op.step = Number(args.step);
      if (args.edge) op.edge = String(args.edge);
      return send([op]);
    }

    case 'board_draw':
      return send(listArg(args.ops, 'ops'), { audit: true });

    /* The settled board is the one the person is left with, so its measurement
       is the one that counts: everything before it was drawn against positions
       that settling may still move. */
    case 'board_settle':
      return send([{ op: 'settle' }], { audit: true });

    case 'board_step':
      return send([{ op: 'focus', step: args.step == null ? null : Number(args.step) - 1 }]);

    case 'board_tag': {
      const tags = listArg(args.tags, 'tags');
      return send(tags.map(t => ({ op: 'tag', ...(t as Record<string, unknown>) })));
    }

    case 'board_script': {
      const u = await url();
      const b: Board = await (await fetch(u + '/state')).json();
      const { scriptSteps, tagReport } = await import('../board/script.js');
      const at = scriptSteps(b);
      if (!b.transcript.length) return 'nothing said yet';
      const rows = b.transcript.map((t, i) =>
        `${i + 1}. [${at[i] == null ? 'no step' : 'step ' + (at[i] + 1)}] ${t.text.replace(/\n/g, ' ')}`);
      const r = tagReport(b);
      const out = [rows.join('\n'), '',
        `${r.lines} lines, ${r.tagged} tied to a step, ${r.steps} steps.`];
      if (r.steps && !r.tagged) {
        out.push('Nothing is tagged, so the rail highlights nothing. Tag the lines that explain a single hop.');
      }
      if (!r.ordered) {
        out.push(`The tags run backwards at ${r.backwards.map(x => `line ${x.line} (step ${x.step} after step ${x.after})`).join(', ')}.`,
          'The transcript shows what you said, in the order you said it, so those numbers read as jumbled. ' +
          'If the flow is the spine of this explanation, say the remaining lines in step order. If a line is ' +
          'not really about one hop, untie it with board_tag and step: null rather than leaving it mis-tagged.');
      }
      return out.join('\n');
    }

    case 'board_replay': {
      const u = await url();
      const r: { ops: number, viewers: number } = await (await fetch(u + '/replay')).json();
      if (!r.ops) return 'nothing has been drawn yet, so there is nothing to replay';
      return r.viewers
        ? `replaying ${r.ops} ops for ${r.viewers} viewer${r.viewers === 1 ? '' : 's'}`
        : `${r.ops} ops ready, but no window is watching \u2014 call board_open first`;
    }

    case 'board_chapter':
      return send([{ op: 'chapter', title: String(args.title ?? '') }]);

    case 'board_amend': {
      const chapter = typeof args.chapter === 'string' && /^\d+$/.test(args.chapter.trim())
        ? Number(args.chapter) : args.chapter;
      return send([{ op: 'amend', chapter, ops: listArg(args.ops, 'ops') }], { audit: true });
    }

    case 'board_clear':
      return send([{ op: 'clear', keepTitle: !!args.keepTitle }]);

    case 'board_snapshot': {
      const u = await url();
      const html = await (await fetch(u + '/snapshot')).text();
      const out = path.resolve(args.path || 'board.html');
      const fs = await import('node:fs');
      fs.writeFileSync(out, html);
      return `saved ${out}`;
    }

    case 'board_open': {
      const u = await url();
      const { showBoard } = await import('../board/open.js');
      // the board's own name, which is the tag in its window title
      const name = u.split('/b/')[1]?.replace(/\/$/, '') || '';
      const r = await showBoard(u, name, { app: !args.tab, size: args.size });
      // A browser that vanished between the check and the launch (#186) is
      // reported like any other tool failure — the catch in handle() below
      // turns this into an isError result — not thrown through an open
      // JSON-RPC connection, which took the whole server down with it.
      if (!r.ok) throw new Error(r.how);
      return `${u} — ${r.raised ? `already open, ${r.how}` : `opened in ${r.how}`}`;
    }

    case 'board_url':
      return await url();

    default:
      throw new Error(`no such tool "${name}"`);
  }
}

/* ---------- JSON-RPC over stdio ---------- */

const write = (msg: unknown): boolean => process.stdout.write(JSON.stringify(msg) + '\n');
const ok = (id: unknown, result: unknown): boolean => write({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, message: string): boolean => write({ jsonrpc: '2.0', id, error: { code: -32000, message } });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

/* A JSON-RPC message, as far as this reads one. */
interface Message {
  id?: unknown;
  method?: string;
  params?: { protocolVersion?: string, name?: string, arguments?: Args };
}

async function handle(line: string): Promise<boolean | undefined> {
  let msg: Message;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'spiega', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || id == null) return;
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = await call(params?.name, params?.arguments || {});
      return ok(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: 'spiega: ' + (e as Error).message }], isError: true });
    }
  }
  if (method === 'ping') return ok(id, {});
  fail(id, `unknown method "${method}"`);
}

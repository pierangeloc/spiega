#!/usr/bin/env node
/* ============================================================
   spiega op-schema — what board_draw and board_amend tell an MCP client an
   op looks like, generated from the op union.

   The tools used to say `ops` was a bare `object`, so a model drawing
   mid-sentence had nothing to go on but the prose, and malformed ops arrived
   to be refused one field at a time (#136). The op union in
   packages/core/src/schema/op.ts is already the definition the server decodes
   against at POST /op; this turns it into JSON Schema, so what a client is
   told and what the board accepts are the same document.

   Generated here, at build time, and committed, rather than at MCP server
   startup. Turning the union into JSON Schema costs 2 ms; importing `effect`
   to do it costs 115 ms, against an `initialize` that answers in under 40 ms
   today and is answered before every agent session can draw anything. So the
   server reads the JSON this writes, and never sees Effect.

   Run from the build, because the op union is TypeScript and only the build
   has it as a module: `pnpm run op-schema`. It writes op-schema.json beside
   the MCP server: the one under its own root by default, which is what the
   suite wants — it runs the copy in dist/ and compares what comes out with
   what the build copied there — or the path on the command line, which is
   how the repository asks for its own (AGENTS.md, "What runs is dist/").
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schema } from 'effect';
import { OPS, KINDS } from '../packages/core/src/schema/op.js';
import { NOT_AMENDABLE } from '../src/board/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The ops board_draw does not advertise, and the tool each has instead.

   An exclusion rather than a list of the twelve that are advertised, so that
   an op added to the union is advertised by default: the first ten ops reach
   an agent through board_draw and nowhere else, and a new one that nobody
   remembered to list here would be an op no model is ever told about. These
   five each have a dedicated tool, and three of them are destructive or
   global, so a second route to them invites a model to reach for the wrong
   one. POST /op still accepts all of them; this is about what is advertised,
   not what is accepted. */
export const OWN_TOOL = {
  focus: 'board_step',
  settle: 'board_settle',
  chapter: 'board_chapter',
  amend: 'board_amend',
  clear: 'board_clear',
};

/* Fields the union accepts and the advertisement hides, found by the leading
   underscore they already carry (#201).

   `_n` and `_i` are written onto the live flow by the renderer and come back
   inside a `flow` op when a long board is compacted, so the union has to read
   them; a model has no use for either, and a model that decides to set one is
   numbering hops the renderer owns. Recursive because `flow` carries a list of
   steps, and the fields are on each of those as well as on `step` itself.

   The prefix is the annotation rather than a second mechanism beside it: both
   fields already say `internal` in the only notation the file has, and op.ts
   says so where they are declared. Nothing else here starts with one. */
const hideInternal = s => {
  if (Array.isArray(s)) return s.map(hideInternal);
  if (!s || typeof s !== 'object') return s;
  return Object.fromEntries(Object.entries(s).flatMap(([k, v]) => {
    if (k === 'properties') {
      return [[k, Object.fromEntries(Object.entries(v)
        .filter(([name]) => !name.startsWith('_'))
        .map(([name, sub]) => [name, hideInternal(sub)]))]];
    }
    if (k === 'required' && Array.isArray(v)) return [[k, v.filter(name => !name.startsWith('_'))]];
    return [[k, hideInternal(v)]];
  }));
};

/* The JSON Schema for one advertised op, as an alternation of their shapes.

   Takes the table of ops rather than importing it, so the suite can hand it a
   table with an op added or changed and see the advertisement follow — which
   is the only proof that it is derived rather than merely equal today.

   `amendable` drops the ops an amendment refuses, from the reducer's own list
   (#200). board_amend used to advertise `title` and then refuse it, which is
   the schema telling a model something the board disagrees with. */
export function advertised(ops = OPS, { amendable = false } = {}) {
  const names = Object.keys(ops).filter(n =>
    !(n in OWN_TOOL) && !(amendable && NOT_AMENDABLE.has(n)));
  const doc = Schema.toJsonSchemaDocument(Schema.Union(names.map(n => ops[n])));

  /* The server nests this under `$defs/op` of each tool's inputSchema, or
     inlines it twice, and either move would leave a reference into
     `definitions` pointing at nothing. Today the union generates none; an op
     that one day makes Effect hoist a shared definition should fail here, by
     name, rather than ship a schema a client cannot resolve. */
  if (Object.keys(doc.definitions).length || JSON.stringify(doc.schema).includes('"$ref"')) {
    throw new Error('the op union now generates shared definitions ($ref), ' +
      'which the MCP tool schemas do not carry — see src/mcp/server.ts');
  }
  return hideInternal(doc.schema);
}

/* What the MCP server reads: the two op schemas, and the kinds board_draw's
   prose names. The kinds ride along because the prose and the schema sit in
   the same tool, a few lines apart, and a list typed out by hand in the server
   was the stale one of the two (#136).

   Two unions rather than one because board_draw and board_amend do not accept
   the same ops. They are separate documents on the wire in any case — each
   tool carries its own `$defs` — so the narrower one costs nothing: amendOp is
   the smaller of the two. */
export const generated = () => ({
  kinds: [...KINDS],
  op: advertised(),
  amendOp: advertised(OPS, { amendable: true }),
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'src', 'mcp', 'op-schema.json');
  fs.writeFileSync(out, JSON.stringify(generated(), null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

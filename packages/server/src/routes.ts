/* ============================================================
   The board server's read routes on Effect's HttpRouter.

   The read routes (board state, identity, board list, index, event stream and
   static assets), the write routes (draw, settle, close) and the routes that
   draw the board into a file (export, snapshot, snapshot.svg). Paths, status
   codes, headers and response shapes match what src/board/server.js answered
   byte for byte so the board page, CLI and MCP clients keep working
   unchanged.
   ============================================================ */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { SpiegaConfig, type SpiegaConfigShape } from './config.js';
import { pictures, type ExportOptions } from './board.js';
import {
  ApplyFailed, BoardNotFound, InvalidJson, NoSuchChapter, NotJson, RenderFailed, messageOf, reply,
} from './errors.js';
import { draw, settle } from './ops.js';
import { SecurityMiddleware, isJsonContentType } from './security.js';
import { BoardStore, type BoardEntry } from './store.js';

export const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
};

const esc = (s: string): string =>
  String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );

const notFound = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text('not found', { status: 404 });

const baseOf = (config: SpiegaConfigShape, hostHeader: string | undefined): string =>
  config.baseUrl() || `http://${hostHeader || `127.0.0.1:${config.port}`}`;

const serveStaticFile = (
  filePath: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.tryPromise(() => fs.readFile(filePath)).pipe(
    Effect.map((buf) =>
      HttpServerResponse.uint8Array(
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        {
          status: 200,
          contentType: MIME[path.extname(filePath)] || 'application/octet-stream',
        },
      ),
    ),
    Effect.catch(() => Effect.succeed(notFound())),
  );

const serveUnder = (
  rootDir: string,
  subDir: 'src',
  rel: string | undefined,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  if (!rel || rel.includes('..')) return Effect.succeed(notFound());
  const baseDir = path.resolve(rootDir, subDir);
  const resolved = path.resolve(baseDir, rel);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    return Effect.succeed(notFound());
  }
  return serveStaticFile(resolved);
};

const renderIndex = (
  store: BoardStore['Service'],
): HttpServerResponse.HttpServerResponse => {
  const open = store.listOpen();
  const saved = store.listSaved();
  if (open.length === 1 && saved.length === 0) {
    return HttpServerResponse.redirect(`/b/${encodeURIComponent(open[0].name)}/`, {
      status: 302,
    });
  }
  const row = (n: string, note = '') =>
    `<li><a href="/b/${encodeURIComponent(n)}/">${esc(n)}</a>${note}</li>`;
  const rows = open.map((e) => row(e.name)).join('');
  const closed = saved
    .map((s) => row(s.name, ` <span style="color:#777">closed</span>`))
    .join('');
  const html =
    `<!doctype html><meta charset=utf-8><title>spiega boards</title>` +
    `<body style="font:14px system-ui;padding:3rem"><h1 style="font-weight:600">spiega</h1>` +
    (rows || closed ? `<ul>${rows}${closed}</ul>` : `<p>No boards yet.`);
  return HttpServerResponse.text(html, { status: 200, contentType: 'text/html' });
};

const missingBoardJson = (name: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    { ok: false, error: `no board named "${name}"` },
    { status: 404 },
  );

const missingBoardHtml = (name: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(
    `<!doctype html><meta charset=utf-8><title>no board</title>` +
      `<body style="font:14px system-ui;padding:3rem">No board named <b>${esc(name)}</b> here. ` +
      `<a href="/">The ones there are</a>.`,
    { status: 404, contentType: 'text/html' },
  );

export const ReadRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const config = yield* SpiegaConfig;
    const store = yield* BoardStore;

    // Static assets: icon and renderer modules under /src/.
    yield* router.add(
      'GET',
      '/icon.svg',
      serveStaticFile(path.join(config.rootDir, 'docs', 'logo', 'spiega-mark.svg')),
    );

    yield* router.add(
      'GET',
      '/src/*',
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        return yield* serveUnder(config.rootDir, 'src', params['*']);
      }),
    );

    /* The React board (#153), beside the old one rather than instead of it.
       One file, assembled by tools/next.js, carrying its own stylesheet, its
       own bundle and a fixture board — so it needs no assets route of its own
       and nothing here has to know which bundle the build named. It draws a
       fixture, not a board held by this server; #156 is the cutover. */
    yield* router.add(
      'GET',
      '/next',
      serveStaticFile(path.join(config.rootDir, 'src', 'next', 'index.html')),
    );

    // Index page (or redirect when there is a single live board and no saved logs).
    const indexHandler = Effect.sync(() => renderIndex(store));
    yield* router.add('GET', '/', indexHandler);
    yield* router.add('GET', '/index.html', indexHandler);

    // Board list (also the probe `spiegaAt` uses to identify a spiega server).
    yield* router.add(
      'GET',
      '/boards',
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const base = baseOf(config, req.headers.host);
        const open = store.listOpen().map((e) => ({
          name: e.name,
          url: `${base}/b/${e.name}`,
          open: true,
          rev: e.board.rev,
          nodes: e.board.nodes.length,
          viewers: e.viewers,
        }));
        const saved = store.listSaved().map((s) => ({
          name: s.name,
          url: `${base}/b/${s.name}`,
          open: false,
          written: s.written,
        }));
        return HttpServerResponse.jsonUnsafe(
          { ok: true, pid: process.pid, url: base, boards: [...open, ...saved] },
          { status: 200 },
        );
      }),
    );

    // /b/:name redirects to /b/:name/ so the board page resolves its API off its path.
    yield* router.add(
      'GET',
      '/b/:name',
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const name = params.name ?? '';
        return HttpServerResponse.redirect(`/b/${encodeURIComponent(name)}/`, {
          status: 302,
        });
      }),
    );

    // Board page: reopens a persisted board on disk if not currently held.
    yield* router.add(
      'GET',
      '/b/:name/',
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const params = yield* HttpRouter.params;
        const name = params.name ?? '';
        const base = baseOf(config, req.headers.host);
        const entry = store.get(name) ?? store.reopen(name, `${base}/b/${name}`);
        if (!entry) return missingBoardHtml(name);
        return yield* serveStaticFile(
          path.join(config.rootDir, 'src', 'board', 'board.html'),
        );
      }),
    );

    // Board state (JSON, never reopens a dropped board).
    yield* router.add(
      'GET',
      '/b/:name/state',
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const name = params.name ?? '';
        const entry = store.get(name);
        if (!entry) return missingBoardJson(name);
        return HttpServerResponse.jsonUnsafe(entry.board, { status: 200 });
      }),
    );

    // Identity route (window title, `spiega boards`, and saving status).
    yield* router.add(
      'GET',
      '/b/:name/whoami',
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const name = params.name ?? '';
        const entry = store.get(name);
        if (!entry) return missingBoardJson(name);
        return HttpServerResponse.jsonUnsafe(
          { name: entry.name, pid: process.pid, viewers: entry.viewers, ...store.saving(entry.name) },
          { status: 200 },
        );
      }),
    );

    yield* router.add(
      'GET',
      '/b/:name/events',
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const name = params.name ?? '';
        const entry = store.get(name);
        if (!entry) return missingBoardJson(name);
        return HttpServerResponse.stream(
          entry.events.stream(() => entry.board, () => store.saving(name)),
          {
            contentType: 'text/event-stream',
            headers: {
              'cache-control': 'no-cache',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            },
          },
        );
      }),
    );
  }),
);

/* The most a body may be before it is refused as unreadable. */
const MAX_BODY = 4e6;

const entryOf = (store: BoardStore['Service'], name: string): Effect.Effect<BoardEntry, BoardNotFound> => {
  const entry = store.get(name);
  return entry ? Effect.succeed(entry) : Effect.fail(new BoardNotFound({ name }));
};

/* After the board is found, so a request for a board that is gone hears "gone"
   whatever it was carrying. */
const requireJson: Effect.Effect<void, NotJson, HttpServerRequest.HttpServerRequest> = Effect.gen(
  function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    if (!isJsonContentType(req.headers['content-type'])) return yield* new NotJson();
  },
);

const jsonBody: Effect.Effect<unknown, InvalidJson, HttpServerRequest.HttpServerRequest> = Effect.gen(
  function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    const text = yield* req.text.pipe(Effect.mapError((e) => new InvalidJson({ message: messageOf(e) })));
    if (text.length > MAX_BODY) return yield* new InvalidJson({ message: 'body too large' });
    return yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (e) => new InvalidJson({ message: messageOf(e) }),
    });
  },
);

/* Draw, settle and close. Nothing here awaits a write: `draw` and `settle` apply
   the ops to the board and hand them to the log's queue, which is flushed by a
   fiber of its own (see oplog.ts). Close is the one route that waits on the
   file, and it is not on the critical path of anyone talking: it is a board
   being let go, and its last tick of ops goes with it. */
export const WriteRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* BoardStore;
    const answer = <R>(
      route: Effect.Effect<HttpServerResponse.HttpServerResponse, BoardNotFound | NotJson | InvalidJson | ApplyFailed, R>,
    ) => route.pipe(Effect.catch((e) => Effect.succeed(reply(e))));

    yield* router.add(
      'POST',
      '/b/:name/op',
      answer(Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const entry = yield* entryOf(store, params.name ?? '');
        yield* requireJson;
        const body = yield* jsonBody;
        /* applyOps refuses what it can see is wrong; this is for what it
           cannot, so a malformed batch still costs one request rather than the
           process. */
        const drawn = yield* Effect.try({
          try: () => draw(entry, body),
          catch: (e) => new ApplyFailed({ message: messageOf(e) }),
        });
        /* After the broadcast, so the pane has already moved and the
           millisecond is spent on the caller's own reply rather than on the
           drawing appearing. */
        const audit = drawn.wantsAudit
          ? { audit: yield* Effect.promise(() => store.audit(drawn.surface)) }
          : {};
        return HttpServerResponse.jsonUnsafe({ ...drawn.reply, ...audit }, { status: drawn.status });
      })),
    );

    yield* router.add(
      'POST',
      '/b/:name/settle',
      answer(Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const entry = yield* entryOf(store, params.name ?? '');
        yield* requireJson;
        yield* Effect.try({
          try: () => settle(entry),
          catch: (e) => new ApplyFailed({ message: messageOf(e) }),
        });
        return HttpServerResponse.jsonUnsafe({ ok: true, board: entry.board }, { status: 200 });
      })),
    );

    /* Let this board go, and leave the other seven drawing. One process holds
       all of them, so stopping one is a map deletion, not a kill. */
    yield* router.add(
      'POST',
      '/b/:name/close',
      answer(Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const name = params.name ?? '';
        yield* entryOf(store, name);
        const left = yield* Effect.promise(() => store.close(name));
        return HttpServerResponse.jsonUnsafe({ ok: true, name, left }, { status: 200 });
      })),
    );
  }),
);

/* A view of the board for the export, taken off the query string exactly as
   the old route read it: `Number` of a missing chapter is 0, and a `viewing`
   that is not one of the page's tabs is a chapter's index. */
const exportOptions = (q: URLSearchParams): ExportOptions => {
  const scope = q.get('scope');
  const viewing = q.get('viewing');
  return {
    chapter: scope === 'chapter' ? Number(q.get('chapter')) : null,
    viewing: scope === 'all' && viewing !== null
      ? (viewing === 'live' || viewing === 'map' ? viewing : Number(viewing))
      : null,
    active: q.has('step') ? Number(q.get('step')) : null,
  };
};

/* The board as a file: the interactive export, the still and the bare SVG.
   Each settles the board first, as the old routes did, so what is saved is
   the drawing a reader would see. A throw while settling or drawing costs that
   render — a 500 with the reason — and not the process every board is in.
   GET only, as the read routes are. */
export const RenderRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* BoardStore;
    const answer = <R>(
      route: Effect.Effect<HttpServerResponse.HttpServerResponse, BoardNotFound | RenderFailed | NoSuchChapter, R>,
    ) => route.pipe(Effect.catch((e) => Effect.succeed(reply(e))));
    const rendering = <A>(draw: () => A): Effect.Effect<A, RenderFailed> =>
      Effect.try({ try: draw, catch: (e) => new RenderFailed({ message: messageOf(e) }) });
    const loaded = Effect.tryPromise({
      try: pictures,
      catch: (e) => new RenderFailed({ message: messageOf(e) }),
    });
    const settled = Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const entry = yield* entryOf(store, params.name ?? '');
      yield* rendering(() => settle(entry));
      return entry;
    });
    const query = Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      return new URL(req.url, 'http://x').searchParams;
    });

    // The board as one standalone file, for pasting into a PR or a doc.
    yield* router.add(
      'GET',
      '/b/:name/export',
      answer(Effect.gen(function* () {
        const { board } = yield* settled;
        const q = yield* query;
        const opts = exportOptions(q);
        const { chapter } = opts;
        if (chapter != null && (!Number.isInteger(chapter) || chapter < 0 || chapter > board.chapters.length)) {
          return yield* new NoSuchChapter();
        }
        const { exportHTML } = yield* loaded;
        const html = yield* rendering(() => exportHTML(board, opts));
        return HttpServerResponse.text(html, {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: { 'content-disposition': 'attachment; filename="spiega-board.html"' },
        });
      })),
    );

    yield* router.add(
      'GET',
      '/b/:name/snapshot',
      answer(Effect.gen(function* () {
        const { board } = yield* settled;
        const q = yield* query;
        const { snapshotHTML } = yield* loaded;
        const html = yield* rendering(() => snapshotHTML(board, { active: q.get('step') }));
        return HttpServerResponse.text(html, { status: 200, contentType: 'text/html' });
      })),
    );

    yield* router.add(
      'GET',
      '/b/:name/snapshot.svg',
      answer(Effect.gen(function* () {
        const { board } = yield* settled;
        const { renderSVG } = yield* loaded;
        const { svg } = yield* rendering(() => renderSVG(board, { margin: 16, active: board.active }));
        return HttpServerResponse.text(svg, { status: 200, contentType: 'image/svg+xml' });
      })),
    );
  }),
);

/* Complete read-only Effect HTTP app with security middleware installed globally. */
export const ReadApp = Layer.mergeAll(SecurityMiddleware, ReadRoutes);

/* Every route the board server answers on Effect: what it runs. */
export const BoardApp = Layer.mergeAll(SecurityMiddleware, ReadRoutes, WriteRoutes, RenderRoutes);

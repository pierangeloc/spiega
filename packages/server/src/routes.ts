/* ============================================================
   The board server's read routes on Effect's HttpRouter.

   Every route here is read-only (board state, identity, board list, index,
   and static assets). Paths, status codes, headers and response shapes match
   src/board/server.js byte for byte so the board page, CLI and MCP clients
   keep working unchanged.
   ============================================================ */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Effect, Layer } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { SpiegaConfig, type SpiegaConfigShape } from './config.js';
import { SecurityMiddleware } from './security.js';
import { BoardStore } from './store.js';

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

/* Complete read-only Effect HTTP app with security middleware installed globally. */
export const ReadApp = Layer.mergeAll(SecurityMiddleware, ReadRoutes);

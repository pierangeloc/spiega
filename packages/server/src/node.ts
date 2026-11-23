/* ============================================================
   Node HTTP adapter for the Effect HttpRouter read app.

   Uses Effect 4's built-in `HttpRouter.toWebHandler` over Node's `node:http`
   without adding any runtime dependency beyond `effect`.

   Two entry points:
   - `createReadWebHandler`: pure Fetch Request -> Response handler for direct
     in-process Effect testing without binding a socket.
   - `createReadBridge`: `handle(req, res): Promise<boolean>` used by
     `src/board/server.js` so every security check and every read route runs
     through Effect's HttpRouter while write routes (#148) stay
     untouched and off the hot path.
   - `createReadNodeServer`: a standalone `node:http.Server` serving only the
     Effect read app, for HTTP-level tests (including raw Host headers).
   ============================================================ */

import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Layer } from 'effect';
import { FindMyWay, HttpRouter } from 'effect/http';
import { SpiegaConfig, type SpiegaConfigShape } from './config.js';
import { ReadApp } from './routes.js';
import { isLoopbackHost, isSameOrAbsentOrigin } from './security.js';
import { BoardStore, type BoardStoreShape } from './store.js';

export type ReadAppServices = SpiegaConfig | BoardStore;

export interface WebHandlerHandle {
  readonly handler: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

export const createReadWebHandler = (
  services: Layer.Layer<ReadAppServices>,
): WebHandlerHandle =>
  HttpRouter.toWebHandler(ReadApp.pipe(Layer.provide(services)), {
    disableLogger: true,
    routerConfig: FindMyWay.strictConfig,
  });

/* Which requests belong to the Effect read router today.
   Write routes (/boards POST, /b/:name/op, /settle, /close),
   and render/mutation routes (/replay, /export, /snapshot, /snapshot.svg)
   return false so src/board/server.js handles them until #148 lands. */
export const isReadRoute = (method: string, pathname: string): boolean => {
  if (method !== 'GET') return false;
  if (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/icon.svg' ||
    pathname === '/boards'
  ) {
    return true;
  }
  if (pathname.startsWith('/src/')) {
    return true;
  }
  const m = /^\/b\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return false;
  const rest = m[2];
  return rest === undefined || rest === '/' || rest === '/state' || rest === '/whoami' || rest === '/events';
};

/* Convert a Node IncomingMessage (headers + method + url, no body needed for
   security rejections, OPTIONS, or GET read routes) into a Web Request.
   Explicitly copies the raw `host` and `origin` headers so DNS-rebinding and
   cross-origin checks see the exact values sent on the wire. */
const toWebRequest = (req: http.IncomingMessage, signal: AbortSignal): Request => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  const rawUrl = req.url || '/';
  return new Request(`http://127.0.0.1${rawUrl}`, {
    method: req.method || 'GET',
    headers,
    signal,
  });
};

const writeWebResponse = async (
  res: http.ServerResponse,
  response: Response,
): Promise<void> => {
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  res.writeHead(response.status, outHeaders);
  if (response.body === null) {
    res.end();
    return;
  }
  if (outHeaders['content-type'] === 'text/event-stream') {
    // Respect socket backpressure instead of buffering the rest of a live stream.
    await pipeline(response.body, res).catch((error: unknown) => {
      if (!res.destroyed) throw error;
    });
    return;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
};

const serveWebRequest = async (
  web: WebHandlerHandle,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  standalone = false,
): Promise<void> => {
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.once('close', onClose);
  if (res.destroyed) onClose();
  try {
    const response = await web.handler(toWebRequest(req, abort.signal));
    if (standalone && response.status === 404 && response.headers.get('content-type') === null) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    await writeWebResponse(res, response);
  } finally {
    res.off('close', onClose);
  }
};

export interface ReadBridge {
  readonly handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  readonly dispose: () => Promise<void>;
}

export const createReadBridge = (
  services: Layer.Layer<ReadAppServices>,
): ReadBridge => {
  const web = createReadWebHandler(services);

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> => {
    const method = (req.method || 'GET').toUpperCase();
    const host = req.headers.host;
    const origin = req.headers.origin;
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;

    // Security rejections, OPTIONS preflights, and all read routes are handled
    // by the Effect HttpRouter + SecurityMiddleware.
    const mustHandle =
      !isLoopbackHost(host) ||
      !isSameOrAbsentOrigin(origin, host) ||
      method === 'OPTIONS' ||
      isReadRoute(method, pathname);

    if (!mustHandle) return false;

    await serveWebRequest(web, req, res);
    return true;
  };

  return { handle, dispose: web.dispose };
};

export const createBoardReadBridge = (
  config: Partial<SpiegaConfigShape>,
  store: BoardStoreShape,
): ReadBridge =>
  createReadBridge(
    Layer.mergeAll(SpiegaConfig.make(config), BoardStore.make(store)),
  );

export const createReadNodeServer = (
  services: Layer.Layer<ReadAppServices>,
): http.Server => {
  const web = createReadWebHandler(services);
  const server = http.createServer(async (req, res) => {
    try {
      await serveWebRequest(web, req, res, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message + '\n');
    }
  });
  server.on('close', () => {
    void web.dispose();
  });
  return server;
};

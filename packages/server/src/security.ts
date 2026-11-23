/* ============================================================
   Who is allowed to talk to the board server.

   Loopback is not a security boundary in a browser: any page the person has
   open can reach 127.0.0.1, and any server emitting CORS headers hands every
   board on this machine — service names, file paths, the full script of the
   explanation — to the internet.

   Three checks, no token, and no CORS headers ever emitted:

   1. Host must be loopback (127.0.0.1, localhost, or [::1], with optional
      port). Defends against DNS rebinding where an attacker domain resolves
      to 127.0.0.1 and the browser treats it as same-origin.
   2. Origin must be absent (CLI, MCP, curl, tests) or match the Host header
      exactly (same host AND port — another server on loopback is a different
      origin, not a friend).
   3. Body-parsing routes require `content-type: application/json`, blocking
      "simple" cross-origin POSTs (`text/plain`) that skip preflight.

   OPTIONS preflights are refused with 403 when Host or Origin fails (telling
   a foreign page nothing about which methods exist), and answered with 204
   and no CORS headers when allowed.
   ============================================================ */

import { Effect } from 'effect';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';

export const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export const isLoopbackHost = (host: string | undefined): boolean =>
  LOOPBACK_HOST.test(host || '');

export const isSameOrAbsentOrigin = (
  origin: string | undefined,
  host: string | undefined,
): boolean => {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

export const isJsonContentType = (contentType: string | undefined): boolean =>
  /^application\/json\b/i.test(contentType || '');

export const NON_LOOPBACK_BODY =
  'spiega serves 127.0.0.1 only; this request arrived for another host\n';
export const FOREIGN_ORIGIN_BODY = 'spiega refuses cross-origin requests\n';
export const EXPECTED_JSON_ERROR = 'expected content-type: application/json';

/* Global Effect HttpRouter middleware enforcing the loopback Host check,
   same-origin-or-absent Origin check, and silent OPTIONS handling.
   Runs before route matching so foreign origins are refused even on unknown
   paths and preflights, and never attaches any CORS header. */
export const SecurityMiddleware = HttpRouter.middleware(
  (app) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (!isLoopbackHost(req.headers.host)) {
        return HttpServerResponse.text(NON_LOOPBACK_BODY, {
          status: 403,
          contentType: 'text/plain',
        });
      }
      if (!isSameOrAbsentOrigin(req.headers.origin, req.headers.host)) {
        return HttpServerResponse.text(FOREIGN_ORIGIN_BODY, {
          status: 403,
          contentType: 'text/plain',
        });
      }
      if (req.method === 'OPTIONS') {
        return HttpServerResponse.empty({ status: 204 });
      }
      return yield* app;
    }),
  { global: true },
);

/* Route-scoped middleware for body-parsing routes (POST /boards, POST /op,
   POST /settle). Refuses non-JSON content types with 415 so simple
   cross-origin POSTs cannot slip past as text/plain. */
export const RequireJsonMiddleware = HttpRouter.middleware((app) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    if (!isJsonContentType(req.headers['content-type'])) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: EXPECTED_JSON_ERROR },
        { status: 415 },
      );
    }
    return yield* app;
  }),
);

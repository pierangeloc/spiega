/* ============================================================
   Server configuration and paths, as Effect services.

   The old server read HOME and SPIEGA_PORT once at module import, so every
   test that needed an isolated ~/.spiega had to spawn its own process and
   mutate process.env before dynamically importing the module. Providing home
   and config through services lets tests substitute a temp directory and
   custom settings with a Layer — no env mutation, no process per test.
   ============================================================ */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Layer } from 'effect';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = path.resolve(HERE, '..', '..', '..');
export const DEFAULT_BOARD = 'default';
export const DEFAULT_PORT = 4777;

/* The log file path for a board name inside a boards directory.
   Matches `boardLogFile` in src/board/log.js so both halves name the same
   file while the log module itself is still being ported. */
export const boardFileIn = (boardsDir: string, name: string): string =>
  path.join(boardsDir, `${String(name).replace(/[^a-z0-9._-]+/gi, '-')}.jsonl`);

export interface SpiegaHomeShape {
  readonly home: string;
  readonly sessionDir: string;
  readonly boardsDir: string;
  readonly boardsFile: string;
  readonly serverFile: string;
  readonly sessionFile: string;
  readonly boardFile: (name: string) => string;
}

export const makeHome = (homeDir: string): SpiegaHomeShape => {
  const sessionDir = path.join(homeDir, '.spiega');
  const boardsDir = path.join(sessionDir, 'boards');
  return {
    home: homeDir,
    sessionDir,
    boardsDir,
    boardsFile: path.join(sessionDir, 'boards.json'),
    serverFile: path.join(sessionDir, 'server.json'),
    sessionFile: path.join(sessionDir, 'session.json'),
    boardFile: (name: string) => boardFileIn(boardsDir, name),
  };
};

/* HOME first, then USERPROFILE for Windows, then the syscall when neither is
   set — the same precedence as src/home.js so the server agrees with the
   shell rather than a cached runtime answer. */
export const resolveHomeDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => env.HOME || env.USERPROFILE || os.homedir();

export class SpiegaHome extends Context.Service<SpiegaHome, SpiegaHomeShape>()(
  '@spiega/server/SpiegaHome',
) {
  static readonly fromPath = (homeDir: string): Layer.Layer<SpiegaHome> =>
    Layer.succeed(SpiegaHome, makeHome(homeDir));

  static readonly fromEnv = (
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): Layer.Layer<SpiegaHome> =>
    Layer.sync(SpiegaHome, () => makeHome(resolveHomeDir(env)));

  static readonly layer: Layer.Layer<SpiegaHome> = SpiegaHome.fromEnv();
}

export interface SpiegaConfigShape {
  readonly rootDir: string;
  readonly port: number;
  readonly defaultBoard: string;
  readonly persist: boolean;
  readonly baseUrl: () => string | null;
}

/* Honouring the pre-rename HANDWAVE_* spelling alongside SPIEGA_* keeps
   half-updated machines and old shell aliases working. */
const readEnvPort = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): number => {
  const raw = env.SPIEGA_PORT ?? env.HANDWAVE_PORT;
  return Number(raw) || DEFAULT_PORT;
};

export const makeConfig = (
  overrides: Partial<SpiegaConfigShape> = {},
): SpiegaConfigShape => ({
  rootDir: overrides.rootDir ?? DEFAULT_ROOT_DIR,
  port: overrides.port ?? DEFAULT_PORT,
  defaultBoard: overrides.defaultBoard ?? DEFAULT_BOARD,
  persist: overrides.persist ?? false,
  baseUrl: overrides.baseUrl ?? (() => null),
});

export class SpiegaConfig extends Context.Service<SpiegaConfig, SpiegaConfigShape>()(
  '@spiega/server/SpiegaConfig',
) {
  static readonly make = (
    overrides: Partial<SpiegaConfigShape> = {},
  ): Layer.Layer<SpiegaConfig> =>
    Layer.succeed(SpiegaConfig, makeConfig(overrides));

  static readonly fromEnv = (
    overrides: Partial<SpiegaConfigShape> = {},
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): Layer.Layer<SpiegaConfig> =>
    Layer.sync(SpiegaConfig, () =>
      makeConfig({
        port: readEnvPort(env),
        ...overrides,
      }),
    );

  static readonly layer: Layer.Layer<SpiegaConfig> = SpiegaConfig.fromEnv();
}

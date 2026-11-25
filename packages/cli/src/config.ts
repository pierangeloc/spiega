/* ============================================================
   CLI configuration and paths, as Effect services.

   install and doctor write into a person's home directory and edit config
   files other tools own, so where they write is the one thing a test must be
   able to point somewhere else. The old modules read HOME and XDG_CONFIG_HOME
   once at import, which forced every test to spawn its own process and mutate
   process.env before dynamically importing the module. Providing home and
   config through a service lets a test substitute a temp directory with a
   Layer — no env mutation, no process per test.

   The precedence is the same as src/home.ts: HOME first, then USERPROFILE for
   Windows, then the syscall when neither is set — so the answer agrees with
   the shell rather than a cached runtime answer.
   ============================================================ */

import os from 'node:os';
import path from 'node:path';
import { Context, Layer } from 'effect';

export interface SpiegaHomeShape {
  readonly home: string;
  /* The XDG config root, honoured rather than assumed: opencode, zed and
     herdr live under it, and a profile launched with XDG_CONFIG_HOME pointed
     elsewhere reads none of ~/.config. */
  readonly config: string;
}

export const resolveHomeDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => env.HOME || env.USERPROFILE || os.homedir();

export const resolveConfigDir = (
  homeDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => env.XDG_CONFIG_HOME || path.join(homeDir, '.config');

export const makeHome = (
  homeDir: string,
  configDir?: string,
): SpiegaHomeShape => ({
  home: homeDir,
  config: configDir ?? path.join(homeDir, '.config'),
});

export class SpiegaHome extends Context.Service<SpiegaHome, SpiegaHomeShape>()(
  '@spiega/cli/SpiegaHome',
) {
  static readonly fromPath = (
    homeDir: string,
    configDir?: string,
  ): Layer.Layer<SpiegaHome> => Layer.succeed(SpiegaHome, makeHome(homeDir, configDir));

  static readonly fromEnv = (
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): Layer.Layer<SpiegaHome> =>
    Layer.sync(SpiegaHome, () => {
      const home = resolveHomeDir(env);
      return makeHome(home, resolveConfigDir(home, env));
    });

  static readonly layer: Layer.Layer<SpiegaHome> = SpiegaHome.fromEnv();
}

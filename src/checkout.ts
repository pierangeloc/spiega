/* ============================================================
   Is this copy a checkout, or an install?

   One word, decided once, and it has to be answerable without loading Effect:
   `spiega --version` asks it, and version is the first thing a person types
   to find out which copy is answering — including on a machine whose
   dependencies are missing, where the Effect-based doctor cannot even load.
   So this stays a plain module, and doctor.ts imports it rather than owning
   it.

   `git -C <dir>` walks UP until it finds a repository, so containment is not
   enough. Installed from npm under nvm — which is itself a git clone — that
   is nvm: doctor reported nvm's HEAD as "this checkout", nvm's dirty file as
   uncommitted work, and then measured every skill and MCP entry against it.
   A page of red crosses, all meaningless, on the most ordinary install there
   is. So the repository has to BE this directory, not merely contain it.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const sh = (cmd: string, args: string[], opts: Record<string, unknown> = {}): string | null => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    }).trim();
  } catch { return null; }
};

/* dist/ is where tools/build.js puts the package, and the manifest it writes
   there is copied from the repository's own — so the two names matching is
   what tells a build apart from a package that merely happens to sit inside
   somebody else's clone. */
function builtFrom(top: string): boolean {
  if (path.basename(ROOT) !== 'dist' ||
      fs.realpathSync(path.dirname(ROOT)) !== fs.realpathSync(top)) return false;
  const name = (f: string): string | null => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')).name; } catch { return null; }
  };
  const mine = name(path.join(ROOT, 'package.json'));
  return Boolean(mine) && mine === name(path.join(top, 'package.json'));
}

let _isCheckout: boolean | null = null;

export function isCheckout(): boolean {
  if (_isCheckout === null) {
    const top = sh('git', ['-C', ROOT, 'rev-parse', '--show-toplevel']);
    if (!top) {
      _isCheckout = false;
    } else {
      try {
        const real = (p: string): string => fs.realpathSync(p);
        _isCheckout = fs.existsSync(top) && (real(top) === real(ROOT) || builtFrom(top));
      } catch { _isCheckout = false; }
    }
  }
  return _isCheckout;
}

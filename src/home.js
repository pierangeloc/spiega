/* ============================================================
   Where home is, in one place.

   The state directory, the node `install` records and every agent config
   spiega writes hang off it, and bin/spiega spells the same directory `$HOME`
   — so this answer has to agree with the shell, not with the runtime.

   os.homedir() is the runtime's answer, and under Bun that answer is fixed at
   startup: reassigning HOME changes nothing. `HOME=/tmp/x` therefore wrote into
   the developer's real ~/.spiega, and the suite's own isolation turned into a
   board file from the previous run, read as a persistence bug. On Node the two
   answers happen to agree, which is why nothing caught it.

   HOME first, then USERPROFILE for Windows, then the syscall for a machine
   with neither set — the only case where the runtime knows better.
   ============================================================ */

import os from 'node:os';

export const home = () => process.env.HOME || process.env.USERPROFILE || os.homedir();

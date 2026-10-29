/* ============================================================
   Just enough TOML to edit one table without eating the rest of the file.

   A table runs from its header to the next line that *starts* a table.

   `[^[]*` looks like it says that, and does not: it stops at the first bracket
   it meets, which is the one in `args = [...]` on the table's own second line.
   Everything after is left behind, and TOML then reads the orphaned
   `["/some/path.js"]` as a table named after a file path.

   That corrupted a real config on this machine — twice, because the same wrong
   pattern had been written in two places. Hence one function, used by both,
   with a test beside it.
   ============================================================ */

/* The whole `[mcp_servers.<name>]` table, header line included. */
export const tomlTable = name =>
  new RegExp(String.raw`^\[mcp_servers\.${name}\][^\n]*\n(?:(?!\[)[^\n]*\n?)*`, 'm');

/* Remove it, leaving the file's own spacing tidy. */
export function dropTable(raw, name) {
  if (!tomlTable(name).test(raw)) return raw;
  return raw.replace(tomlTable(name), '').replace(/\n{3,}/g, '\n\n');
}

/* Add it, or repoint one that is already there. Only our own table is ever
   rewritten, and only as far as the next one. */
export function upsertTable(raw, name, body) {
  const re = tomlTable(name);
  const found = raw.match(re);
  if (!found) return { text: raw.replace(/\n*$/, '\n') + '\n' + body, how: 'added' };
  if (found[0].trim() === body.trim()) return { text: raw, how: 'unchanged' };
  return { text: raw.replace(re, body + '\n'), how: 'repointed' };
}

/* The transcript's one typographic liberty: backticks become code, double
   asterisks become bold, and `&` and `<` are escaped first so a line about
   software cannot write markup into the rail. board.html has this, and so does
   the snapshot — three lines each, because what reads them is three different
   kinds of output. This is the React page's. */

export const mdish = (s: string): string => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

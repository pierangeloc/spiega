# Dagre

`dagre.esm.js` is the unmodified, self-contained ESM bundle from
`@dagrejs/dagre` **3.1.3**, fetched from
https://registry.npmjs.org/@dagrejs/dagre/-/dagre-3.1.3.tgz.
The adjacent license and bundle legal notices travel with it.

SHA-256 of `dagre.esm.js`:
`b0ddaf4af1417bec9bd89373a3a3987f081727d6cc6d95fc40dbf85a19bdf3b0`.

This is the one dependency exception: a finished board uses dagre's rank and
in-rank ordering, without an install, a build, or a network request in the
browser. Pixel layout and drawing remain spiega's. The small declaration file
describes only the public API used by that seam, not dagre's implementation.

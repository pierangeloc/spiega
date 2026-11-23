/* The domain as the reducer holds it.

   Effect derives readonly types from a Schema — properties, records and arrays
   all — which describes a board nobody here has. `applyOp` writes to the board
   in place and sweeps removals because `POST /op` is on the critical path of
   somebody talking, and there is a benchmark holding it to 0.2 ms per op; a
   readonly board would buy immutability with a copy per op on the one path
   that cannot afford one. The ops are the same story from the other end: what
   the reducer receives is a fresh object off `JSON.parse`, owned by nobody
   else, and its lists go onto the board without being copied first.

   So the Schemas stay the single definition and the types they hand out are
   mapped through this. It is the only place the two disagree, which is why it
   is one named type rather than a readonly stripped off at each use. */
export type Mutable<T> =
  T extends readonly (infer U)[] ? Mutable<U>[]
    : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

/* The client entry: one store, one root, nothing else. */

import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { fixtureStore } from './fixture.js';

const root = document.getElementById('root');
if (!root) throw new Error('the React board has no #root to mount in');

/* In a split pane the rail would eat the board, so board.html opens with it
   closed below the same width at which the stylesheet turns it into a drawer
   over the drawing. A reader can still open it from the bar. */
const railOpen = !matchMedia('(max-width:820px)').matches;

createRoot(root).render(<App store={fixtureStore(railOpen)} />);

/* The client entry: one store, one root, nothing else. */

import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { browserStore } from './browser.js';

const root = document.getElementById('root');
if (!root) throw new Error('the React board has no #root to mount in');

/* In a split pane the rail would eat the board, so board.html opens with it
   closed below the same width at which the stylesheet turns it into a drawer
   over the drawing. A reader can still open it from the bar. */
const railOpen = !matchMedia('(max-width:820px)').matches;

const store = browserStore(railOpen);
window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, select, button, [contenteditable]')) return;
  if (['ArrowRight', 'ArrowLeft', 'f', '0', '+', '=', '-', '_', 'Escape'].includes(event.key)
    || (store.getSnapshot().playback.narratorAvailable && [' ', 'ArrowDown', 'ArrowUp', '[', ']'].includes(event.key))) event.preventDefault();
  store.dispatch({ type: 'keyDown', key: event.key });
});
addEventListener('hashchange', () => store.dispatch({ type: 'hashChanged', hash: location.hash }));
createRoot(root).render(<App store={store} />);

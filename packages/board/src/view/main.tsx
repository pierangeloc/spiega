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
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(target.tagName))) return;
  if ([' ', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', '[', ']', 'r', 'Escape'].includes(event.key)) {
    if (event.key !== ' ' || store.getSnapshot().playback.narratorAvailable) event.preventDefault();
    store.dispatch({ type: 'keyDown', key: event.key });
  }
});
createRoot(root).render(<App store={store} />);

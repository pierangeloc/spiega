# The herdr plugin

Eight tasks in flight, each with its own board, means the window you want is
behind seven others. Hunting for it is exactly the friction the board was meant
to remove.

```bash
handwave install herdr      # or: herdr plugin link integrations/herdr
```

Three actions, offered from the global, workspace, tab and pane menus:

| action | what it does |
|---|---|
| **handwave: show this task's board** | raises the board belonging to this pane, starting one if there is none |
| **handwave: open a board for this task** | a window for this pane's board, always |
| **handwave: list every board** | a popup: every board and the task it belongs to |

Bind the first one to a key — it is the one worth pressing.

## How it finds the right board

It reads the pane, not the conversation. `herdr pane list` gives each pane's
`foreground_cwd`; handwave names a board after its task's directory; so the
pane's directory *is* the lookup. Nothing depends on the agent cooperating, or
even on an agent being in the pane.

`HERDR_PANE_ID` is used when herdr sets it, and the focused pane otherwise,
because an action can be invoked globally — and a plugin's own working
directory is the plugin, not the task.

## What it cannot do yet

Raising a window is macOS-only, through AppleScript: the board name is in the
window title, and the title is the only handle an OS has on a browser app
window. On Linux this would be `wmctrl` or `xdotool`; the action prints the URL
instead of pretending.

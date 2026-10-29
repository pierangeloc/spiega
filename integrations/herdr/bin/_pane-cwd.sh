# Where is the pane the person is looking at?
#
# HERDR_PANE_ID is set when herdr runs us from a pane, but a plugin action can
# also be invoked globally, and a plugin's own working directory is the plugin,
# not the task. So ask herdr: the focused pane's foreground_cwd is the directory
# the person is actually in, which is the directory spiega names a board after.
pane_cwd() {
  herdr pane list 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const panes = JSON.parse(s).result.panes;
        const want = process.env.HERDR_PANE_ID;
        const mine = want && panes.find(p => p.pane_id === want);
        const p = mine || panes.find(p => p.focused) || panes[0];
        if (p) process.stdout.write(p.foreground_cwd || p.cwd || "");
      } catch { /* no herdr, no answer */ }
    });
  ' 2>/dev/null
}

#!/bin/sh
# Actions cannot open a pane directly, so this opens the pane entrypoint above.
exec herdr plugin pane open spiega.board list

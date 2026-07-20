# Flow 071 — /-menu focus-transfer nav

Live feedback: arrows/Enter did not drive the / dropdown (manual key routing failed); Enter submitted a raw /. Fix: the first arrow transfers focus to the SelectRenderable (which then handles nav+Enter natively, as mouse-focus did); ITEM_SELECTED runs the command. Plus echo the command and make the composer compact.

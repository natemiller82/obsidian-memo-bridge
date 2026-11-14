// Code shared with the plugin uses window.setTimeout (Obsidian's popout-safe timers); under Node,
// window is the global object.
(globalThis as { window?: unknown }).window ??= globalThis;

/**
 * The WebExtension API under one name. Firefox exposes promise-based
 * `browser`; Chrome and Edge expose `chrome`, whose MV3 methods also return
 * promises when no callback is passed. Both match the `chrome` typings for the
 * calls this extension makes, so no polyfill is needed.
 */
type Ext = typeof chrome;

export const ext: Ext = (globalThis as { browser?: Ext }).browser ?? (globalThis as { chrome: Ext }).chrome;

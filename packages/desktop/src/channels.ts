// The channels between the main process (updates.ts) and the page (preload.ts).

// Main to page: the version of the update downloaded. Page to main: asks for it.
export const UPDATE_READY_CHANNEL = 'updates:ready';
// Page to main: restart into the downloaded update.
export const RESTART_CHANNEL = 'updates:restart';

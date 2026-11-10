// The channels between the main process (updates.ts, notifications.ts) and the page (preload.ts).

// Main to page: the version of the update downloaded. Page to main: asks for it.
export const UPDATE_READY_CHANNEL = 'updates:ready';
// Page to main: restart into the downloaded update.
export const RESTART_CHANNEL = 'updates:restart';
// Page to main: show a notification of what an agent said, with the page of the app it is on.
export const NOTIFY_CHANNEL = 'notifications:show';
// Main to page: the page of the app to open, from a notification clicked.
export const OPEN_PATH_CHANNEL = 'notifications:open';
// Page to main: how many conversations have something unread, for the app's badge.
export const BADGE_CHANNEL = 'badge:set';
// Page to main: begin a Claude sign-in, opening Claude's page in the browser.
export const CLAUDE_SIGN_IN_START_CHANNEL = 'claude-sign-in:start';
// Page to main: the code pasted from Claude, traded for the token the page connects.
export const CLAUDE_SIGN_IN_FINISH_CHANNEL = 'claude-sign-in:finish';

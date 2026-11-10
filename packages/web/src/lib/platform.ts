// Whether the browser runs on an Apple system, whose shortcuts use the Command key where others
// use Control.
function isApple(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/** Whether a key press is the platform's shortcut with `key`: Cmd on a Mac, Ctrl elsewhere, and nothing else held. */
export function isShortcut(event: KeyboardEvent, key: string): boolean {
	const held = isApple() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	return held && !event.altKey && !event.shiftKey && event.key.toLowerCase() === key;
}

/** A shortcut as the platform writes it: "⌘K" on a Mac, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string): string {
	return isApple() ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}

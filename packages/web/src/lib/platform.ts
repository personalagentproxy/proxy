// Whether the browser runs on an Apple system, whose shortcuts use the Command key where others
// use Control.
function isApple(): boolean {
	return /Mac|iPhone|iPad/.test(navigator.userAgent);
}

// The letter a key press is, as a shortcut reads it: what the layout types where that is a Latin
// letter, so Dvorak's K is K wherever it is; on a layout of another script, whose K types "л"
// or "κ", the letter at the key's place on a US keyboard.
function letterOf(event: KeyboardEvent): string {
	const key = event.key.toLowerCase();
	if (/^[a-z]$/.test(key) || !/^Key[A-Z]$/.test(event.code)) {
		return key;
	}
	return event.code.slice('Key'.length).toLowerCase();
}

/** Whether a key press is the platform's shortcut with `key`: Cmd on a Mac, Ctrl elsewhere, and nothing else held. */
export function isShortcut(event: KeyboardEvent, key: string): boolean {
	const held = isApple() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	return held && !event.altKey && !event.shiftKey && letterOf(event) === key;
}

/** A shortcut as the platform writes it: "⌘K" on a Mac, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string): string {
	return isApple() ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}

// Whether the page holds something a reload would lose: a write still on its way to the api, an
// open dialog, or text the person typed into a field that is still there and not empty. A field
// counts once typed into, so one the page filled in itself, as a settings page does with a name,
// holds nothing, and the chat box, emptied when its message is sent, holds nothing again.

let writesInFlight = 0;

/** Counts `write` as on its way until it settles; it is returned as it is. */
export function trackWrite<T>(write: Promise<T>): Promise<T> {
	writesInFlight += 1;
	return write.finally(() => {
		writesInFlight -= 1;
	});
}

// Where text is typed: a textarea, or an input of one of these types.
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function isTextField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
	if (!(target instanceof Element)) {
		return false;
	}

	if (target.tagName === 'TEXTAREA') {
		return true;
	}

	return (
		target.tagName === 'INPUT' && TEXT_TYPES.has((target.getAttribute('type') ?? '').toLowerCase())
	);
}

const typedInto = new WeakSet<HTMLInputElement | HTMLTextAreaElement>();

function noteTyping(event: Event): void {
	if (isTextField(event.target)) {
		typedInto.add(event.target);
	}
}

/** Notes the fields typed into in `doc` from now on, until the returned function is called. */
export function watchTyping(doc: Document): () => void {
	doc.addEventListener('input', noteTyping, true);
	return () => {
		doc.removeEventListener('input', noteTyping, true);
	};
}

function hasTypedText(doc: Document): boolean {
	for (const field of doc.querySelectorAll('input, textarea')) {
		if (isTextField(field) && typedInto.has(field) && field.value !== '') {
			return true;
		}
	}

	return false;
}

/** Whether reloading `doc` now would lose something. */
export function hasUnsavedWork(doc: Document): boolean {
	if (writesInFlight > 0) {
		return true;
	}

	if (doc.querySelector('[role="dialog"], [role="alertdialog"]')) {
		return true;
	}

	return hasTypedText(doc);
}

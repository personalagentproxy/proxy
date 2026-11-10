import type {ChatAttachment} from '@proxy/contracts/harness';
import {ATTACHMENT_MARK, attachedParts} from '@proxy/utils/harness';
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import {createPortal} from 'react-dom';
import {PendingChip} from '@/components/chat/attachments';
import type {PendingAttachment} from '@/hooks/use-attachments';
import {cn} from '@proxy/ui/lib/utils';

/**
 * The box a message is typed in, where the files put in it sit among the words, each a chip at
 * the place it was put: at the caret, or at the end where the box wasn't being typed in. It is
 * text and nothing but, edited in place by the browser: what is pasted is pasted as text, a line
 * is broken with Shift+Enter, and Enter sends. A chip is one thing to the caret, stepped over and
 * deleted whole, by Backspace as a letter is or by the cross in it.
 *
 * What the box holds is read from it as it changes (`onChange`): the text, with a mark where each
 * file sits (`ATTACHMENT_MARK`), and those files in the order of their marks. A file still on its
 * way up, or one that failed, has a chip and no mark: it is no part of the message yet. The box's
 * own content is the browser's, not React's: only the chips' insides are drawn by React, each
 * into the place the box keeps for it.
 */

/** What the box holds: the text with a mark for each file in it, and the files, in the order of their marks. */
export type Typed = {text: string; files: ChatAttachment[]};

/** What whoever holds the box can do to it: empty it, as after a send, and put the caret in it. */
export type MessageEditorHandle = {clear: () => void; focus: () => void};

type Props = {
	ref: Ref<MessageEditorHandle>;
	// What it opens holding, read once: the text typed before, and the files then in the input.
	opening: {text: string; files: PendingAttachment[]};
	// The files in the input now: one that has no chip yet gets one, at the caret; a chip whose
	// file is no longer among them goes.
	files: PendingAttachment[];
	label: string;
	placeholder: string;
	onChange: (typed: Typed) => void;
	// A chip was deleted from the text, or taken out by its cross.
	onRemove: (file: PendingAttachment) => void;
	// Files were pasted into the box; left out where the conversation takes none.
	onFiles?: (files: File[]) => void;
	// Enter was pressed.
	onSubmit: () => void;
};

// What marks a chip's place in the box, with its file's key.
const FILE_KEY = 'data-file';

// A chip's place: a word of the line, with a hair of room either side, that the caret treats as
// one thing.
function placeFor(key: number): HTMLElement {
	const place = document.createElement('span');
	place.setAttribute(FILE_KEY, String(key));
	place.contentEditable = 'false';
	place.className = 'inline-block px-0.5 py-0.5 align-middle';
	return place;
}

function keyOf(node: Node): number | null {
	if (!(node instanceof HTMLElement)) {
		return null;
	}
	const key = node.getAttribute(FILE_KEY);
	return key === null ? null : Number(key);
}

// What the box holds, read from its nodes in order: text as it is, a line break as one, and a
// chip as its key; whatever else the browser put there is read for what is inside it.
function readNodes(node: Node, into: Array<string | number>): void {
	for (const child of node.childNodes) {
		const key = keyOf(child);
		if (key !== null) {
			into.push(key);
			continue;
		}
		if (child.nodeType === Node.TEXT_NODE) {
			into.push(child.nodeValue ?? '');
			continue;
		}
		if (child instanceof HTMLElement && child.tagName === 'BR') {
			into.push('\n');
			continue;
		}
		readNodes(child, into);
	}
}

// What the box holds, as one string to tell two holdings apart by.
function signature(text: string, files: ChatAttachment[]): string {
	return [text, ...files.map((file) => `${file.connectionId}/${file.fileId}/${file.version}`)].join(
		'\u0000',
	);
}

export function MessageEditor({
	ref,
	opening,
	files,
	label,
	placeholder,
	onChange,
	onRemove,
	onFiles,
	onSubmit,
}: Props) {
	const box = useRef<HTMLDivElement>(null);
	// The chips' places in the box, by their files' keys, for React to draw each chip into.
	const [places, setPlaces] = useState<Map<number, HTMLElement>>(new Map());
	const [empty, setEmpty] = useState(opening.text === '' && opening.files.length === 0);
	// Where the caret last was in the box, for a file put in while it is elsewhere, as in the
	// file picker.
	const caret = useRef<Range | null>(null);
	// The keys of the files that have had a chip: one of them without a chip now was deleted from
	// the text, where one that never had one is new.
	const placed = useRef(new Set<number>());
	// What was last told of the box, so that what it holds is told only when it changes: as it
	// opens, what it opens with.
	const told = useRef(
		signature(
			opening.text,
			opening.files.flatMap((file) => (file.attachment === null ? [] : [file.attachment])),
		),
	);
	const latest = useRef({files, onChange, onRemove});
	useLayoutEffect(() => {
		latest.current = {files, onChange, onRemove};
	});

	// Reads the box and tells what it holds; a chip no longer in it was deleted, and is told too.
	const read = useCallback(() => {
		const element = box.current;
		if (element === null) {
			return;
		}
		const nodes: Array<string | number> = [];
		readNodes(element, nodes);
		const {files: now, onChange: tell, onRemove: gone} = latest.current;
		const kept = new Set(nodes.filter((node) => typeof node === 'number'));
		const attached: ChatAttachment[] = [];
		const text = nodes
			.map((node) => {
				if (typeof node === 'string') {
					return node;
				}
				const attachment = now.find((file) => file.key === node)?.attachment ?? null;
				if (attachment === null) {
					return '';
				}
				attached.push(attachment);
				return ATTACHMENT_MARK;
			})
			.join('');
		// Emptied of words and chips, the box is left with nothing, not the line break a browser
		// leaves behind.
		const nothing = kept.size === 0 && text.trim() === '';
		if (nothing && element.childNodes.length > 0 && text === '') {
			element.textContent = '';
		}
		setEmpty(nothing);
		setPlaces((before) => {
			const still = new Map([...before].filter(([key]) => kept.has(key)));
			return still.size === before.size ? before : still;
		});
		for (const file of now) {
			if (!kept.has(file.key) && placed.current.has(file.key)) {
				placed.current.delete(file.key);
				gone(file);
			}
		}
		const holds = signature(text, attached);
		if (holds !== told.current) {
			told.current = holds;
			tell({text, files: attached});
		}
	}, []);

	// Opens holding what it held before: the words, and each file where its mark is.
	useLayoutEffect(() => {
		const element = box.current;
		if (element === null) {
			return;
		}
		// From nothing: in development an effect runs twice, and the box would hold it all twice.
		element.textContent = '';
		const made = new Map<number, HTMLElement>();
		for (const part of attachedParts(opening.text, opening.files)) {
			if ('text' in part) {
				element.append(document.createTextNode(part.text));
				continue;
			}
			const place = placeFor(part.file.key);
			made.set(part.file.key, place);
			placed.current.add(part.file.key);
			element.append(place);
		}
		setPlaces(made);
		// Only as it opens: what it holds afterwards is what is typed in it.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// A file new to the input gets a chip where the caret is, or was; a chip whose file has left
	// the input goes. What the box holds is then told again, a file that has landed among it.
	useEffect(() => {
		const element = box.current;
		if (element === null) {
			return;
		}
		const keys = new Set(files.map((file) => file.key));
		for (const place of element.querySelectorAll(`[${FILE_KEY}]`)) {
			const key = keyOf(place);
			if (key !== null && !keys.has(key)) {
				placed.current.delete(key);
				place.remove();
			}
		}
		const added = files.filter((file) => !placed.current.has(file.key));
		if (added.length > 0) {
			const at =
				caret.current !== null && element.contains(caret.current.startContainer)
					? caret.current
					: null;
			at?.deleteContents();
			const made: Array<[number, HTMLElement]> = [];
			let after: Node | null = null;
			for (const file of added) {
				const place = placeFor(file.key);
				placed.current.add(file.key);
				made.push([file.key, place]);
				if (after !== null) {
					after.parentNode?.insertBefore(place, after.nextSibling);
				} else if (at !== null) {
					at.insertNode(place);
				} else {
					element.append(place);
				}
				after = place;
			}
			setPlaces((before) => new Map([...before, ...made]));
			// The caret goes on after the last chip, where the next word is typed.
			if (after !== null) {
				const next = document.createRange();
				next.setStartAfter(after);
				next.collapse(true);
				caret.current = next;
				if (document.activeElement === element) {
					const selection = window.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(next);
				}
			}
		}
		read();
	}, [files, read]);

	// Where the caret is, kept while it is in the box: as it moves, and as the box is typed in,
	// clicked in or left, since a browser doesn't say every move of it.
	const keepCaret = useCallback(() => {
		const selection = window.getSelection();
		const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
		if (range !== null && box.current?.contains(range.startContainer)) {
			caret.current = range.cloneRange();
		}
	}, []);
	useEffect(() => {
		document.addEventListener('selectionchange', keepCaret);
		return () => document.removeEventListener('selectionchange', keepCaret);
	}, [keepCaret]);

	useImperativeHandle(
		ref,
		() => ({
			clear: () => {
				if (box.current !== null) {
					box.current.textContent = '';
				}
				placed.current.clear();
				caret.current = null;
				told.current = signature('', []);
				setPlaces(new Map());
				setEmpty(true);
			},
			focus: () => box.current?.focus(),
		}),
		[],
	);

	// Enter sends, unless a word is still being composed; Shift+Enter breaks the line, as the
	// browser does it.
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			onSubmit();
		}
	};
	// A file pasted into the message, as a screenshot is, is attached rather than typed. What is
	// copied as words too, as cells of a spreadsheet are with a picture of them, is pasted as the
	// words.
	const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
		const pasted = [...event.clipboardData.files];
		if (!onFiles || pasted.length === 0 || event.clipboardData.getData('text/plain') !== '') {
			return;
		}
		event.preventDefault();
		onFiles(pasted);
	};

	return (
		<>
			<div
				ref={box}
				role="textbox"
				aria-multiline="true"
				aria-label={label}
				aria-placeholder={placeholder}
				data-slot="input-group-control"
				data-placeholder={placeholder}
				data-empty={empty}
				contentEditable="plaintext-only"
				suppressContentEditableWarning
				onInput={() => {
					keepCaret();
					read();
				}}
				onKeyUp={keepCaret}
				onMouseUp={keepCaret}
				onBlur={keepCaret}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				className={cn(
					'min-h-10 w-full p-3 text-base break-words whitespace-pre-wrap outline-none md:text-sm',
					'data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-muted-foreground data-[empty=true]:before:content-[attr(data-placeholder)]',
				)}
			/>
			{files.map((file) => {
				const place = places.get(file.key);
				return place
					? createPortal(
							<PendingChip file={file} onRemove={() => onRemove(file)} />,
							place,
							String(file.key),
						)
					: null;
			})}
		</>
	);
}

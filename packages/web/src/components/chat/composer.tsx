import type {ChatAttachment, ChatHarness, ChatPersona} from '@proxy/contracts/harness';
import {PaperclipIcon} from 'lucide-react';
import {type FormEvent, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {updatePersona} from '@/client/harness-client';
import {DropToAttach} from '@/components/chat/attachments';
import {
	MessageEditor,
	type MessageEditorHandle,
	type Typed,
} from '@/components/chat/message-editor';
import {type ModelChoice, ModelSwitcher} from '@/components/model-switcher';
import {type AttachmentInput, takenFiles, useAttachments} from '@/hooks/use-attachments';
import type {ChatDraft} from '@/hooks/use-chat-draft';
import {useExperiments} from '@/hooks/use-experiment';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {useReloadWhileHidden} from '@/hooks/use-reload-on-release';
import {useWindowFileDrop} from '@/hooks/use-window-file-drop';
import {describeFetchError} from '@/lib/loader-utils';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';
import {InputGroup, InputGroupAddon} from '@proxy/ui/components/input-group';
import {PillButton} from '@proxy/ui/components/pill-button';
import {cn} from '@proxy/ui/lib/utils';

// Nothing to wait for before a send, where nothing typed is kept on the server.
const settled = () => Promise.resolve();

type Props = {
	persona: ChatPersona;
	harnesses: ChatHarness[];
	// What the box is called, and what it says while it is empty.
	label: string;
	placeholder: string;
	// Where its files go, and those in it as it opens.
	input: AttachmentInput;
	keptFiles: ChatAttachment[];
	// What it opens holding.
	openingText: string;
	// What is typed, kept on the server as the chat's draft; null where nothing typed is kept, as
	// in a thread's box, whose files the page alone holds too.
	kept: ChatDraft | null;
	// What is typed, as it is typed, and what waits in the box, the files' names where nothing is.
	onTyped?: (text: string) => void;
	onWaiting?: (waiting: string) => void;
	// An agent is being made, changed or deleted in a dialog.
	managing: boolean;
	// Whether files dropped anywhere on the window come here: not to the chat's box while a thread
	// is open beside it, whose box takes them.
	takesDrops?: boolean;
	// What something beside the box failed with, said where its own failures are.
	otherError?: string | null;
	// Whether the box should take the keyboard's focus, once it can.
	focusRequested: boolean;
	onFocused: () => void;
	// Sends a message, with the files placed among it, once `settle` has: what it failed with, or
	// null.
	onSend: (
		message: string,
		files: ChatAttachment[],
		settle: () => Promise<void>,
	) => Promise<string | null>;
	className?: string;
};

/**
 * The box a message is written in, under the chat and under a thread, the same in both: the words
 * with the files placed among them, what runs the persona, a paperclip where the organization has
 * Files, and Send. What is typed is its own, so typing draws the box, not the chat over it. A
 * message sent leaves the box at once, its files with it, and comes back to it where the send
 * fails.
 */
export function Composer({
	persona,
	harnesses,
	label,
	placeholder,
	input,
	keptFiles,
	openingText,
	kept,
	onTyped,
	onWaiting,
	managing,
	takesDrops = true,
	otherError = null,
	focusRequested,
	onFocused,
	onSend,
	className,
}: Props) {
	const org = useOrgSlug();
	const reload = useReload();
	const personaId = persona.id;
	// What goes with the next message: the files the person put in the box, where the
	// organization has Files. Sent once none is still on its way up, with words, files, or both.
	const attaches = useExperiments().includes('files');
	const attachments = useAttachments(input, keptFiles);
	// The files in the box now, as a send that waited on the server finds them.
	const pendingNow = useRef(attachments.pending);
	useLayoutEffect(() => {
		pendingNow.current = attachments.pending;
	});
	// What the box opens holding: what it opened with, or, made again where a send failed (`made`
	// times), what the send gave back.
	const [box, setBox] = useState(() => ({made: 0, text: openingText, files: attachments.pending}));
	// What is typed, with a mark where each file sits among the words, and those files in the
	// order of their marks (message-editor.tsx).
	const [text, setText] = useState(openingText);
	const [placed, setPlaced] = useState(keptFiles);
	// What is in the box now, as a send that waited on the server finds it.
	const typedNow = useRef<Typed>({text: openingText, files: keptFiles});
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<MessageEditorHandle>(null);
	// What runs the persona, as the switcher shows it: what was just picked, until the persona has
	// changed since, as the chat's box and a thread's both show it once it is read again; otherwise
	// the persona's.
	const ran = {harness: persona.harness, chatModel: persona.chatModel};
	const [picked, setPicked] = useState<{choice: ModelChoice; over: ModelChoice} | null>(null);
	const runsOn =
		picked !== null &&
		picked.over.harness === ran.harness &&
		picked.over.chatModel === ran.chatModel
			? picked.choice
			: ran;
	// A chat is open all day: a new release is loaded while it is out of view, as long as what is
	// in the box is kept, or there is nothing in it, and no dialog is open.
	const keptAll =
		kept === null ? text === '' && attachments.pending.length === 0 : text === kept.saved;
	useReloadWhileHidden(keptAll && !sending && !managing && !attachments.uploading);

	// What waits in the box: what is typed, or, with nothing typed, the files' names. Said as it is
	// drawn, so the list shows the draft as it is typed.
	const words = text.replaceAll(ATTACHMENT_MARK, '').trim();
	const waiting = words === '' ? attachments.pending.map((one) => one.name).join(', ') : text;
	useLayoutEffect(() => {
		onWaiting?.(waiting);
	}, [onWaiting, waiting]);

	useEffect(() => {
		if (!focusRequested || editor.current === null) {
			return;
		}
		editor.current.focus();
		onFocused();
	}, [focusRequested, onFocused]);

	// The box made again, where a send failed, keeps the caret.
	useEffect(() => {
		if (box.made > 0) {
			editor.current?.focus();
		}
	}, [box.made]);

	// What the box shows, as the page remembers it; `type` keeps it as the draft too.
	const show = (typed: Typed) => {
		setText(typed.text);
		setPlaced(typed.files);
		typedNow.current = typed;
		onTyped?.(typed.text);
	};
	const type = (typed: Typed) => {
		show(typed);
		kept?.typed(typed.text, typed.files);
	};

	// Switches what runs the persona, the harness and the model, from the box's switcher: shown at
	// once, kept with the persona as it is otherwise, and put back where the server refused it.
	const switchModel = async (choice: ModelChoice) => {
		setPicked({choice, over: ran});
		setError(null);
		const changed = await updatePersona(org, personaId, {
			name: persona.name,
			look: persona.look,
			color: persona.color,
			...choice,
		});
		if (changed.isErr()) {
			setPicked(null);
			setError(describeFetchError(changed.error));
			return;
		}
		await reload();
	};

	const picker = useRef<HTMLInputElement>(null);
	// A file that could not be uploaded says why over the box, by its name.
	const failedFile = attachments.pending.find((one) => one.error !== null);
	const failedUpload = failedFile ? `${failedFile.name}: ${failedFile.error ?? ''}` : null;
	const sendable = !attachments.uploading && (words !== '' || placed.length > 0);
	// Files dropped anywhere on the window are attached, unless a dialog is open over the page.
	const dropping = useWindowFileDrop(attaches && takesDrops && !managing, attachments.add);

	// The message leaves the box at once, its files with it. Where the send fails, it comes back,
	// before anything typed since; where it doesn't, what was typed since is kept as the draft,
	// which the send forgot.
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const message = text.trim();
		if (!sendable || sending) {
			return;
		}
		const files = placed;
		const taken = takenFiles(attachments.pending, files);
		setSending(true);
		setError(null);
		editor.current?.clear();
		attachments.sent();
		show({text: '', files: []});
		const failed = await onSend(message, files, kept?.settle ?? settled);
		setSending(false);
		if (failed !== null) {
			setError(failed);
			const since = typedNow.current;
			const back: Typed = {
				text: since.text === '' ? text : `${text}\n${since.text}`,
				files: [...files, ...since.files],
			};
			attachments.restore(taken);
			setBox((before) => ({
				made: before.made + 1,
				text: back.text,
				files: [...taken, ...takenFiles(pendingNow.current, since.files)],
			}));
			type(back);
			return;
		}
		kept?.sent();
		if (typedNow.current.text !== '') {
			kept?.typed(typedNow.current.text, typedNow.current.files);
		}
	};

	const shownError = error ?? attachments.refused ?? failedUpload ?? otherError;

	return (
		<form
			ref={form}
			onSubmit={(event) => void submit(event)}
			className={cn('flex w-full shrink-0 flex-col gap-2 pt-2 pb-4', className)}
		>
			{dropping && <DropToAttach name={persona.name} />}
			{shownError && <p className="text-sm text-destructive">{shownError}</p>}
			<input
				ref={picker}
				type="file"
				multiple
				className="hidden"
				aria-label="Files to attach"
				onChange={(event) => {
					const picked = [...(event.target.files ?? [])];
					event.target.value = '';
					attachments.add(picked);
				}}
			/>
			{/* No focus ring: the caret says where typing goes. */}
			<InputGroup className="rounded-xl bg-background shadow-xs has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-0">
				<MessageEditor
					key={box.made}
					ref={editor}
					opening={box}
					files={attachments.pending}
					label={label}
					placeholder={placeholder}
					onChange={type}
					onRemove={attachments.remove}
					onFiles={attaches ? attachments.add : undefined}
					onSubmit={() => form.current?.requestSubmit()}
				/>
				{/* The model's name starts where the message's hint does: 5px, the switcher's 1px border
				    and its 6px padding make the textarea's 12px. It sits on the send button's bottom. */}
				<InputGroupAddon align="block-end" className="items-end pl-[5px]">
					<ModelSwitcher
						harnesses={harnesses}
						chosen={runsOn}
						mayChange={persona.mayChange}
						onPick={(choice) => void switchModel(choice)}
					/>
					{attaches && (
						<PillButton
							type="button"
							variant="ghost"
							icon
							className="ml-auto"
							onClick={() => picker.current?.click()}
							aria-label="Attach files"
						>
							<PaperclipIcon />
						</PillButton>
					)}
					{/* The command bar's main button without its label: Enter's mark, as Enter sends. */}
					<PillButton
						type="submit"
						enter
						className={cn(!attaches && 'ml-auto')}
						disabled={sending || !sendable}
						aria-label="Send"
					/>
				</InputGroupAddon>
			</InputGroup>
		</form>
	);
}

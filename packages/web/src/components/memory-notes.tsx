import type {FileDetail, FileVersion} from '@proxy/contracts/files';
import type {MemoryNote} from '@proxy/contracts/memory';
import {FILES_TRASH_DAYS, MEMORY_ABOUT_TITLE} from '@proxy/integrations';
import {GitCompareArrowsIcon, PencilIcon, RotateCcwIcon, Trash2Icon} from 'lucide-react';
import {useEffect, useState} from 'react';
import {
	fileContentPath,
	getFile,
	restoreFileVersion,
	trashFile,
	uploadFile,
	uploadFileVersion,
} from '@/client/files-client';
import {AddButton} from '@/components/add-button';
import {AuthorCell, Makers} from '@/components/file-browser';
import {IconButton} from '@/components/icon-button';
import {Markdown} from '@/components/markdown';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useApply} from '@/hooks/use-apply';
import {useOrgSlug} from '@/hooks/use-org';
import {formatAgo, formatDateTime} from '@/lib/format';
import {diffLines, type DiffLine} from '@/lib/line-diff';
import {describeApiError} from '@/lib/loader-utils';
import {Badge} from '@proxy/ui/components/badge';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Textarea} from '@proxy/ui/components/textarea';
import {cn} from '@proxy/ui/lib/utils';

const EMPTY = 'Nothing yet. Your agents keep what they learn here as they work, for next time.';
const NO_ABOUT = 'Nothing yet. Your agents write down what they learn about you here.';

const CELLS = {
	makers: 'hidden w-20 shrink-0 justify-end sm:flex',
	modified: 'w-28 shrink-0 text-right text-muted-foreground',
};

// What a note's file is called, by its title.
function fileOf(title: string, content: string): File {
	return new File([content], `${title.trim()}.md`, {type: 'text/markdown'});
}

// A version's text, as its content route sends it.
async function versionText(path: string): Promise<string> {
	const response = await fetch(path, {credentials: 'same-origin'});
	return response.ok ? response.text() : '';
}

// What a version changed from the one before it, a line at a time.
function Changes({lines}: {lines: DiffLine[]}) {
	if (lines.every((line) => line.kind === 'same')) {
		return <p className="px-3 py-2 text-sm text-muted-foreground">No change to the text.</p>;
	}
	return (
		<pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 py-2 font-mono text-xs leading-5">
			{lines.map((line, index) => (
				<div
					key={index}
					className={cn(
						'flex gap-2 px-3 whitespace-pre-wrap',
						line.kind === 'added' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
						line.kind === 'removed' &&
							'bg-red-500/15 text-red-700 line-through decoration-red-500/40 dark:text-red-300',
						line.kind === 'same' && 'text-muted-foreground',
					)}
				>
					<span className="select-none">
						{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
					</span>
					<span>{line.text || ' '}</span>
				</div>
			))}
		</pre>
	);
}

// A note's versions, newest first, each with who wrote it and when, what it changed from the one
// before, shown on asking, and giving it back.
function History({
	connectionId,
	note,
	versions,
}: {
	connectionId: string;
	note: MemoryNote;
	versions: FileVersion[];
}) {
	const org = useOrgSlug();
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const [shown, setShown] = useState<{id: string; lines: DiffLine[]} | null>(null);

	const compare = async (index: number) => {
		const version = versions[index];
		if (!version) {
			return;
		}
		if (shown?.id === version.id) {
			setShown(null);
			return;
		}
		const before = versions[index + 1];
		const [now, then] = await Promise.all([
			versionText(fileContentPath(org, connectionId, note.id, version.id)),
			before
				? versionText(fileContentPath(org, connectionId, note.id, before.id))
				: Promise.resolve(''),
		]);
		setShown({id: version.id, lines: diffLines(then, now)});
	};

	return (
		<div className="flex min-w-0 flex-col gap-1">
			<h3 className="text-sm font-medium">History</h3>
			<ul className="flex max-h-96 flex-col overflow-y-auto text-sm">
				{versions.map((version, index) => (
					<li key={version.id} className="flex flex-col gap-2 border-t border-border/60 py-2">
						<div className="flex items-center gap-3">
							<span className="min-w-0 flex-1">
								<AuthorCell by={version.by} />
							</span>
							<span className="shrink-0 text-muted-foreground" title={formatDateTime(version.at)}>
								{formatAgo(version.at)}
							</span>
							<span className="w-16 shrink-0">
								{version.current && (
									<Badge variant="secondary" className="font-normal">
										Current
									</Badge>
								)}
							</span>
							<span className="flex shrink-0">
								<IconButton
									label={shown?.id === version.id ? 'Hide changes' : 'Show changes'}
									onClick={() => void compare(index)}
								>
									<GitCompareArrowsIcon />
								</IconButton>
								{!version.current && (
									<IconButton
										label="Restore this version"
										onClick={() =>
											void apply(restoreFileVersion(org, connectionId, note.id, version.id))
										}
									>
										<RotateCcwIcon />
									</IconButton>
								)}
							</span>
						</div>
						{shown?.id === version.id && <Changes lines={shown.lines} />}
					</li>
				))}
			</ul>
			{error && <p className="text-sm text-destructive">{error}</p>}
		</div>
	);
}

// A note opened: what it says, written over by the person, forgotten, and its history.
function NoteDialog({
	connectionId,
	note,
	onClose,
}: {
	connectionId: string;
	note: MemoryNote;
	onClose: () => void;
}) {
	const org = useOrgSlug();
	const [detail, setDetail] = useState<FileDetail | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);

	useEffect(() => {
		let left = false;
		void getFile(org, connectionId, note.id).then((answer) => {
			if (left) {
				return;
			}
			if (answer.isErr()) {
				setError(describeApiError(answer.error));
				return;
			}
			setDetail(answer.value);
		});
		return () => {
			left = true;
		};
	}, [org, connectionId, note.id, note.version]);

	return (
		<DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-3xl">
			<DialogHeader>
				<DialogTitle className="truncate">{note.title}</DialogTitle>
				<DialogDescription className="flex items-center gap-2">
					{note.makers.length > 0 ? 'Written by your agents' : 'Written by you'}
					<Makers makers={note.makers} />
					<span>· changed {formatAgo(note.modifiedAt)}</span>
				</DialogDescription>
			</DialogHeader>
			{editing === null ? (
				<>
					<div className="flex justify-end gap-1">
						<IconButton label="Edit" onClick={() => setEditing(note.content)}>
							<PencilIcon />
						</IconButton>
						<IconButton
							label="Forget"
							onClick={() => void apply(trashFile(org, connectionId, note.id), onClose)}
						>
							<Trash2Icon />
						</IconButton>
					</div>
					<div className="max-h-96 overflow-y-auto rounded-md border px-4 py-3">
						<Markdown text={note.content} className="text-sm" />
					</div>
				</>
			) : (
				<>
					<Textarea
						aria-label="What the note says"
						value={editing}
						onChange={(event) => setEditing(event.target.value)}
						className="max-h-96 min-h-48 font-mono text-xs"
					/>
					<DialogFooter>
						<PillButton variant="ghost" onClick={() => setEditing(null)}>
							Cancel
						</PillButton>
						<PillButton
							onClick={() =>
								void apply(
									uploadFileVersion(
										org,
										connectionId,
										note.id,
										note.version,
										fileOf(note.title, editing),
									),
									() => setEditing(null),
								)
							}
						>
							Save
						</PillButton>
					</DialogFooter>
				</>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{detail && <History connectionId={connectionId} note={note} versions={detail.versions} />}
		</DialogContent>
	);
}

// A new note, written by the person: its title and what it says.
function NewNoteDialog({
	connectionId,
	about,
	onClose,
}: {
	connectionId: string;
	about: boolean;
	onClose: () => void;
}) {
	const org = useOrgSlug();
	const [title, setTitle] = useState(about ? MEMORY_ABOUT_TITLE : '');
	const [content, setContent] = useState('');
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	return (
		<DialogContent>
			<DialogHeader>
				<DialogTitle>{about ? MEMORY_ABOUT_TITLE : 'New note'}</DialogTitle>
				<DialogDescription>
					Its first line is the summary every thread of your agents is given.
				</DialogDescription>
			</DialogHeader>
			{!about && (
				<Input
					aria-label="Title"
					placeholder="Title"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
			)}
			<Textarea
				aria-label="What the note says"
				placeholder="What your agents should remember"
				value={content}
				onChange={(event) => setContent(event.target.value)}
				className="min-h-40"
			/>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<DialogFooter>
				<PillButton variant="ghost" onClick={onClose}>
					Cancel
				</PillButton>
				<PillButton
					disabled={title.trim() === '' || content.trim() === ''}
					onClick={() =>
						void apply(uploadFile(org, connectionId, fileOf(title, content), null), onClose)
					}
				>
					Save
				</PillButton>
			</DialogFooter>
		</DialogContent>
	);
}

type Open = {note: MemoryNote} | {new: 'note' | 'about'};

type Props = {connectionId: string; notes: MemoryNote[]};

/**
 * The Notes part of a member's memory's page, the first of its connection's tabs: what their
 * agents learned as they worked, kept for next time. About you first, which every thread is given
 * whole; then the other notes, each by its summary, which threads are given as an index, with the
 * agents that wrote it. A note opens with its history: who wrote each version, what it changed,
 * and giving an earlier one back.
 */
export function MemoryNotes({connectionId, notes}: Props) {
	const [open, setOpen] = useState<Open | null>(null);
	const about = notes.find((note) => note.about);
	const others = notes.filter((note) => !note.about);
	const close = () => setOpen(null);

	return (
		<div className="flex flex-col gap-6">
			<div className="flex min-h-8 items-center justify-between gap-4 text-sm text-muted-foreground">
				<span>
					What your agents learned as they worked, for next time. Forgotten notes stay in the trash
					for {FILES_TRASH_DAYS} days.
				</span>
				<AddButton label="Add note" variant="ghost" onClick={() => setOpen({new: 'note'})} />
			</div>
			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-medium">{MEMORY_ABOUT_TITLE}</h3>
				<button
					type="button"
					onClick={() => setOpen(about ? {note: about} : {new: 'about'})}
					className="rounded-lg border px-4 py-3 text-left hover:bg-muted/40"
				>
					{about ? (
						<Markdown text={about.content} className="line-clamp-6 text-sm" />
					) : (
						<span className="text-sm text-muted-foreground">{NO_ABOUT}</span>
					)}
				</button>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-medium">Notes</h3>
				<RowList
					header={
						<RowHeader>
							<span className="min-w-0 flex-1">Note</span>
							<span className={CELLS.makers}>Written by</span>
							<span className={CELLS.modified}>Changed</span>
						</RowHeader>
					}
				>
					{others.length === 0 && <EmptyRows>{EMPTY}</EmptyRows>}
					{others.map((note) => (
						<Row
							key={note.id}
							onClick={() => setOpen({note})}
							title={note.title}
							subtitle={note.summary === note.title ? undefined : note.summary}
							cells={
								<>
									<span className={CELLS.makers}>
										<Makers makers={note.makers} />
									</span>
									<span className={CELLS.modified} title={formatDateTime(note.modifiedAt)}>
										{formatAgo(note.modifiedAt)}
									</span>
								</>
							}
						/>
					))}
				</RowList>
			</section>
			<Dialog
				open={open !== null}
				onOpenChange={(next) => {
					if (!next) {
						close();
					}
				}}
			>
				{open && 'note' in open && (
					<NoteDialog
						connectionId={connectionId}
						note={notes.find((note) => note.id === open.note.id) ?? open.note}
						onClose={close}
					/>
				)}
				{open && 'new' in open && (
					<NewNoteDialog connectionId={connectionId} about={open.new === 'about'} onClose={close} />
				)}
			</Dialog>
		</div>
	);
}

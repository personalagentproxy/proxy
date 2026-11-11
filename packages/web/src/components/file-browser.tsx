import type {
	DriveFile,
	FileCrumb,
	FileDetail,
	FileList,
	FileMaker,
	FileVersion,
} from '@proxy/contracts/files';
import {FILES_TRASH_DAYS} from '@proxy/integrations';
import {
	ArchiveRestoreIcon,
	ChevronRightIcon,
	DownloadIcon,
	FileIcon,
	FolderIcon,
	FolderInputIcon,
	FolderPlusIcon,
	ImageIcon,
	LoaderCircleIcon,
	PencilIcon,
	RotateCcwIcon,
	SearchIcon,
	Trash2Icon,
	UploadIcon,
} from 'lucide-react';
import {Fragment, useEffect, useRef, useState, type DragEvent} from 'react';
import {Link, useNavigate} from 'react-router';
import {
	createFolder,
	fileContentPath,
	listFiles,
	moveFile,
	renameFile,
	restoreFileVersion,
	trashFile,
	untrashFile,
	uploadFile,
	uploadFileVersion,
} from '@/client/files-client';
import {IconButton} from '@/components/icon-button';
import {PersonAvatar} from '@/components/person-avatar';
import {PillButton} from '@/components/pill-button';
import {AgentLogo} from '@/components/brand-logo';
import {Head} from '@/components/head';
import {RenameDialog} from '@/components/rename-dialog';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useApply} from '@/hooks/use-apply';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {type DrivePlace, driveQuery} from '@/lib/files';
import {formatAgo, formatDateTime} from '@/lib/format';
import {describeApiError} from '@/lib/loader-utils';
import {formatBytes} from '@proxy/utils/bytes';
import {Badge} from '@proxy/ui/components/badge';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';

const EMPTY = 'Nothing here yet. Upload a file, or let your agents put what they make here.';
const EMPTY_TRASH = 'Nothing in the trash.';
const EMPTY_FOUND = 'Nothing by that name here.';

// How long after the last keystroke a search is run.
const SEARCH_AFTER_MS = 250;

// What the top of a drive is called where the folders above something are listed.
const TOP = 'Files';
const GONE = 'That folder isn’t here any more.';

const TRASH_NOTE = `What is put in the trash is deleted for good after ${FILES_TRASH_DAYS} days.`;

// The table's columns after the name.
const CELLS = {
	makers: 'hidden w-20 shrink-0 justify-end sm:flex',
	size: 'hidden w-20 shrink-0 text-right text-muted-foreground tabular-nums sm:block',
	modified: 'w-28 shrink-0 text-right text-muted-foreground',
};

const LINK = 'underline underline-offset-4 hover:text-foreground';

function FileGlyph({file}: {file: DriveFile}) {
	const Icon = file.folder ? FolderIcon : file.shown ? ImageIcon : FileIcon;
	return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

// How many of a file's makers are drawn; the rest are counted.
const MAX_MAKERS = 3;

// The names of a file's makers, as a sentence says them.
const NAMES = new Intl.ListFormat('en', {type: 'conjunction'});

// A maker as the activity log draws one: a persona by its head, any other agent by its mark.
function MakerMark({maker}: {maker: FileMaker}) {
	if (maker.kind === 'persona') {
		return <Head look={maker.look} color={maker.color} size={20} />;
	}
	return <AgentLogo providerId={maker.providerId} />;
}

// The agents that made what a file holds, the latest in front, overlapping, the first few drawn
// and the rest counted, named under the pointer; nothing for a file only members made.
function Makers({makers}: {makers: FileMaker[]}) {
	if (makers.length === 0) {
		return null;
	}
	const names = `Made by ${NAMES.format(makers.map((maker) => maker.name))}`;
	const drawn = makers.slice(0, MAX_MAKERS);
	const more = makers.length - drawn.length;
	return (
		<Tooltip>
			<TooltipTrigger render={<span aria-label={names} className="flex items-center gap-1" />}>
				<span className="flex -space-x-1.5">
					{drawn.map((maker, index) => (
						<span
							key={`${maker.kind}-${maker.id}`}
							className="flex"
							style={{zIndex: drawn.length - index}}
						>
							<MakerMark maker={maker} />
						</span>
					))}
				</span>
				{more > 0 && <span className="text-xs text-muted-foreground">+{more}</span>}
			</TooltipTrigger>
			<TooltipContent>{names}</TooltipContent>
		</Tooltip>
	);
}

// Where the list is, from the drive's top down: each folder above a link to it, the one opened
// last and plain.
function Trail({trail, trash}: {trail: FileCrumb[]; trash: boolean}) {
	if (trash) {
		return (
			<span className="flex min-w-0 items-center gap-1.5">
				<Link to={driveQuery({})} className={LINK}>
					Files
				</Link>
				<ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
				<span className="text-foreground">Trash</span>
			</span>
		);
	}
	if (trail.length === 0) {
		return null;
	}
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-1.5">
			<Link to={driveQuery({})} className={LINK}>
				Files
			</Link>
			{trail.map((crumb, index) => (
				<Fragment key={crumb.id}>
					<ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
					{index === trail.length - 1 ? (
						<span className="truncate text-foreground">{crumb.name}</span>
					) : (
						<Link to={driveQuery({folder: crumb.id})} className={cn(LINK, 'truncate')}>
							{crumb.name}
						</Link>
					)}
				</Fragment>
			))}
		</span>
	);
}

// The versions table's columns: the file's name then, its size, when, by whom, whether the file
// holds it now, and what can be done with it.
const VERSION_COLUMNS =
	'grid grid-cols-[minmax(0,1fr)_4rem_5.5rem_minmax(0,13rem)_4.5rem_4.5rem] items-center gap-3';

// Who made a version, as far as it is known: a member by their avatar, or an agent as the file's
// makers are drawn, with the task it was for under its name.
function VersionBy({version}: {version: FileVersion}) {
	const org = useOrgSlug();
	const {by} = version;
	if (by === null) {
		return <span className="text-muted-foreground">Unknown</span>;
	}
	const task = by.kind === 'person' ? null : by.task;
	return (
		<span className="flex min-w-0 items-center gap-2">
			{by.kind === 'person' ? (
				<PersonAvatar person={by} className="size-5 text-[10px]" />
			) : (
				<MakerMark maker={by} />
			)}
			<span className="flex min-w-0 flex-col">
				<span className="truncate">{by.name}</span>
				{task && (
					<Link
						to={`/${org}/activity/tasks/${task.id}`}
						title={task.title}
						className={cn(LINK, 'truncate text-xs text-muted-foreground')}
					>
						{task.title}
					</Link>
				)}
			</span>
		</span>
	);
}

type ShownProps = {
	connectionId: string;
	shown: FileDetail;
	onClose: () => void;
	onRename: (file: DriveFile) => void;
	onMove: (file: DriveFile) => void;
};

// A file opened over its folder: a picture as it is, what the file is, saving it, a new version
// of it, and its versions, newest first, each saved or given back.
function ShownFile({connectionId, shown, onClose, onRename, onMove}: ShownProps) {
	const org = useOrgSlug();
	const {file, versions} = shown;
	const picker = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const trashed = file.trashedAt !== null;
	const details = [
		file.type,
		file.size === null ? null : formatBytes(file.size),
		trashed ? 'In the trash' : null,
	]
		.filter(Boolean)
		.join(' · ');

	return (
		<DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-3xl">
			<DialogHeader>
				<DialogTitle className="truncate">{file.name}</DialogTitle>
			</DialogHeader>
			{file.shown && file.version !== null && (
				<img
					src={fileContentPath(org, connectionId, file.id, file.version)}
					alt={file.name}
					className="max-h-72 w-full rounded-md border object-contain"
				/>
			)}
			<div className="flex items-center gap-2">
				<p className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={details}>
					{details}
				</p>
				<span className="flex shrink-0 items-center gap-1">
					<IconButton
						label="Download"
						href={fileContentPath(org, connectionId, file.id)}
						download={file.name}
					>
						<DownloadIcon />
					</IconButton>
					{!trashed && (
						<>
							<IconButton label="Upload new version" onClick={() => picker.current?.click()}>
								<UploadIcon />
							</IconButton>
							<IconButton label="Rename" onClick={() => onRename(file)}>
								<PencilIcon />
							</IconButton>
							<IconButton label="Move" onClick={() => onMove(file)}>
								<FolderInputIcon />
							</IconButton>
							<IconButton
								label="Move to trash"
								onClick={() => void apply(trashFile(org, connectionId, file.id), onClose)}
							>
								<Trash2Icon />
							</IconButton>
						</>
					)}
					{trashed && (
						<IconButton
							label="Take out of trash"
							onClick={() => void apply(untrashFile(org, connectionId, file.id), onClose)}
						>
							<ArchiveRestoreIcon />
						</IconButton>
					)}
				</span>
			</div>
			<input
				ref={picker}
				type="file"
				className="hidden"
				aria-label="A new version of the file"
				onChange={(event) => {
					const [picked] = event.target.files ?? [];
					event.target.value = '';
					if (picked && file.version !== null) {
						void apply(uploadFileVersion(org, connectionId, file.id, file.version, picked));
					}
				}}
			/>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex min-w-0 flex-col gap-1">
				<h3 className="text-sm font-medium">Versions</h3>
				<div className={cn(VERSION_COLUMNS, 'h-8 text-xs text-muted-foreground')}>
					<span>Name</span>
					<span className="text-right">Size</span>
					<span>When</span>
					<span>By</span>
					<span>Status</span>
					<span className="sr-only">Actions</span>
				</div>
				<ul className="flex max-h-80 flex-col overflow-y-auto text-sm">
					{versions.map((version) => (
						<li
							key={version.id}
							className={cn(VERSION_COLUMNS, 'min-h-12 border-t border-border/60 py-1.5')}
						>
							<span className="flex min-w-0 flex-col">
								<span className="truncate" title={version.name}>
									{version.name}
								</span>
								{version.restored && (
									<span className="text-xs text-muted-foreground">
										An earlier version given back
									</span>
								)}
							</span>
							<span className="text-right text-muted-foreground tabular-nums">
								{formatBytes(version.size)}
							</span>
							<span className="text-muted-foreground" title={formatDateTime(version.at)}>
								{formatAgo(version.at)}
							</span>
							<VersionBy version={version} />
							<span>
								{version.current && (
									<Badge variant="secondary" className="font-normal">
										Current
									</Badge>
								)}
							</span>
							<span className="flex">
								<IconButton
									label="Download this version"
									href={fileContentPath(org, connectionId, file.id, version.id)}
									download={version.name}
								>
									<DownloadIcon />
								</IconButton>
								{!trashed && !version.current && (
									<IconButton
										label="Restore this version"
										onClick={() =>
											void apply(restoreFileVersion(org, connectionId, file.id, version.id))
										}
									>
										<RotateCcwIcon />
									</IconButton>
								)}
							</span>
						</li>
					))}
				</ul>
			</div>
		</DialogContent>
	);
}

// The folders a move's dialog has listed, and the folder they are in.
type Listed = {at: string | null; list: FileList};

// Moving a file or a folder: the drive's folders, opened one into the next from where it is now,
// and the one it goes into, chosen by standing in it. A folder is not offered itself to go into.
function MoveDialog({
	connectionId,
	file,
	onClose,
}: {
	connectionId: string;
	file: DriveFile;
	onClose: () => void;
}) {
	const org = useOrgSlug();
	const reload = useReload();
	const [at, setAt] = useState<string | null>(file.parentId);
	const [listed, setListed] = useState<Listed | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [moving, setMoving] = useState(false);

	useEffect(() => {
		let left = false;
		void listFiles(org, connectionId, at).then((answer) => {
			if (left) {
				return;
			}
			if (answer.isErr()) {
				setError(describeApiError(answer.error));
				return;
			}
			setError(null);
			setListed({at, list: answer.value});
		});
		return () => {
			left = true;
		};
	}, [org, connectionId, at]);

	// What was listed for another folder is not this one's.
	const list = listed?.at === at ? listed.list : null;
	const folders = (list?.files ?? []).filter((one) => one.folder && one.id !== file.id);
	const move = async () => {
		setMoving(true);
		const moved = await moveFile(org, connectionId, file.id, at);
		setMoving(false);
		if (moved.isErr()) {
			setError(describeApiError(moved.error));
			return;
		}
		onClose();
		await reload();
	};

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle className="truncate">Move {file.name}</DialogTitle>
					<DialogDescription>Open the folder it goes into, then move it there.</DialogDescription>
				</DialogHeader>
				<nav
					aria-label="Folders above"
					className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
				>
					<button type="button" className={LINK} onClick={() => setAt(null)}>
						{TOP}
					</button>
					{(list?.trail ?? []).map((crumb, index, trail) => (
						<Fragment key={crumb.id}>
							<ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
							{index === trail.length - 1 ? (
								<span className="truncate text-foreground">{crumb.name}</span>
							) : (
								<button
									type="button"
									className={cn(LINK, 'truncate')}
									onClick={() => setAt(crumb.id)}
								>
									{crumb.name}
								</button>
							)}
						</Fragment>
					))}
				</nav>
				<ul className="flex max-h-64 min-h-24 flex-col overflow-y-auto text-sm">
					{list !== null && folders.length === 0 && (
						<li className="py-2 text-muted-foreground">No folders in here.</li>
					)}
					{folders.map((folder) => (
						<li key={folder.id}>
							<button
								type="button"
								onClick={() => setAt(folder.id)}
								className="flex h-9 w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left hover:bg-muted/50"
							>
								<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">{folder.name}</span>
								<ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
							</button>
						</li>
					))}
				</ul>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<DialogFooter>
					<PillButton type="button" variant="ghost" onClick={onClose}>
						Cancel
					</PillButton>
					<PillButton
						type="button"
						disabled={list === null || moving || at === file.parentId}
						onClick={() => void move()}
					>
						{moving ? 'Moving…' : 'Move here'}
					</PillButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// The search of a drive, by name: in the folder opened and below it, or the whole drive at its
// top, run a moment after the last keystroke, as part of the page's address.
function Search({place}: {place: DrivePlace}) {
	const navigate = useNavigate();
	const [typed, setTyped] = useState(place.search ?? '');
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) {
				clearTimeout(timer.current);
			}
		},
		[],
	);
	const search = (value: string) => {
		setTyped(value);
		if (timer.current !== null) {
			clearTimeout(timer.current);
		}
		timer.current = setTimeout(() => {
			void navigate(driveQuery({folder: place.folder, search: value.trim() || null}), {
				replace: true,
				preventScrollReset: true,
			});
		}, SEARCH_AFTER_MS);
	};

	return (
		<span className="relative flex items-center">
			<SearchIcon
				aria-hidden
				className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
			/>
			<Input
				type="search"
				value={typed}
				onChange={(event) => search(event.target.value)}
				placeholder="Search by name"
				aria-label={place.folder === null ? 'Search this drive' : 'Search this folder'}
				className="h-8 w-44 pl-7"
			/>
		</span>
	);
}

type Props = {
	// The drive's connection.
	connectionId: string;
	// Where the person is in it, what is listed there, and the file shown over it; a list or a
	// file that isn't there is null.
	place: DrivePlace;
	list: FileList | null;
	shown: FileDetail | null;
};

// The Files part of a drive's page, the first of its connection's tabs: the folder the person is
// in, its folders and files a row each, opened by a click, or what a search by name found in it
// and below, each with where it is; with what puts more in it: an upload, by the button or by
// dropping files on the list, and a new folder. A file opens over its folder with its versions,
// and a file or a folder is renamed, moved into another folder, or put in the trash from its
// row's menu. The trash is a list of its own, each thing in it taken out again.
export function FileBrowser({connectionId, place, list, shown}: Props) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const picker = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(0);
	const [dropping, setDropping] = useState(false);
	const [naming, setNaming] = useState<{file: DriveFile | null} | null>(null);
	const [moving, setMoving] = useState<DriveFile | null>(null);
	const apply = useApply(setError);
	const {folder, trash, search} = place;
	const files = list?.files ?? [];

	// One after the other, so each finds the name the one before took; the first failure is said
	// and the rest still go.
	const upload = async (picked: File[]) => {
		setError(null);
		setUploading(picked.length);
		for (const file of picked) {
			const sent = await uploadFile(org, connectionId, file, folder);
			if (sent.isErr()) {
				setError(`${file.name}: ${describeApiError(sent.error)}`);
			}
			setUploading((left) => left - 1);
		}
		setUploading(0);
		await reload();
	};
	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setDropping(false);
		const dropped = [...event.dataTransfer.files];
		if (dropped.length > 0 && !trash) {
			void upload(dropped);
		}
	};
	const closeShown = () =>
		void navigate(driveQuery({folder, trash, search}), {replace: true, preventScrollReset: true});

	return (
		<div className="flex flex-col gap-2">
			<div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-muted-foreground">
				<Trail trail={list?.trail ?? []} trash={trash} />
				{!trash && list !== null && (
					<span className="ml-auto flex items-center gap-1">
						<Search key={folder ?? 'top'} place={place} />
						<IconButton label="Trash" to={driveQuery({trash: true})}>
							<Trash2Icon />
						</IconButton>
						<IconButton label="New folder" onClick={() => setNaming({file: null})}>
							<FolderPlusIcon />
						</IconButton>
						<IconButton
							label={uploading > 0 ? `Uploading ${uploading}…` : 'Upload'}
							disabled={uploading > 0}
							onClick={() => picker.current?.click()}
						>
							{uploading > 0 ? <LoaderCircleIcon className="animate-spin" /> : <UploadIcon />}
						</IconButton>
					</span>
				)}
			</div>
			<input
				ref={picker}
				type="file"
				multiple
				className="hidden"
				aria-label="Files to upload"
				onChange={(event) => {
					const picked = [...(event.target.files ?? [])];
					event.target.value = '';
					if (picked.length > 0) {
						void upload(picked);
					}
				}}
			/>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div
				onDragOver={(event) => {
					if (!trash && event.dataTransfer.types.includes('Files')) {
						event.preventDefault();
						setDropping(true);
					}
				}}
				onDragLeave={() => setDropping(false)}
				onDrop={onDrop}
				className={cn(
					'rounded-md',
					dropping && 'outline-2 outline-offset-4 outline-ring outline-dashed',
				)}
			>
				<RowList
					header={
						<RowHeader>
							<span className="size-4 shrink-0" />
							<span className="min-w-0 flex-1">Name</span>
							<span className={CELLS.makers}>Made by</span>
							<span className={CELLS.size}>Size</span>
							<span className={CELLS.modified}>{trash ? 'Trashed' : 'Modified'}</span>
						</RowHeader>
					}
				>
					{list === null && (
						<EmptyRows>
							{GONE}{' '}
							<Link to={driveQuery({})} className={LINK}>
								Back to the top
							</Link>
						</EmptyRows>
					)}
					{list !== null && files.length === 0 && (
						<EmptyRows>{trash ? EMPTY_TRASH : search === null ? EMPTY : EMPTY_FOUND}</EmptyRows>
					)}
					{files.map((file) => (
						<Row
							key={file.id}
							to={
								file.folder && !trash
									? driveQuery({folder: file.id})
									: driveQuery({folder, trash, search, file: file.id})
							}
							icon={<FileGlyph file={file} />}
							title={file.name}
							// Where it is, for what a search found or the trash holds.
							subtitle={file.path === null ? undefined : file.path || TOP}
							cells={
								<>
									<span className={CELLS.makers}>
										<Makers makers={file.makers} />
									</span>
									<span className={CELLS.size}>
										{file.size === null ? '' : formatBytes(file.size)}
									</span>
									<span className={CELLS.modified}>
										{formatAgo(file.trashedAt ?? file.modifiedAt)}
									</span>
								</>
							}
							menu={
								trash ? (
									<ContextMenuItem
										onClick={() => void apply(untrashFile(org, connectionId, file.id))}
									>
										Take out of trash
									</ContextMenuItem>
								) : (
									<>
										<ContextMenuItem onClick={() => setNaming({file})}>Rename</ContextMenuItem>
										<ContextMenuItem onClick={() => setMoving(file)}>Move to…</ContextMenuItem>
										<ContextMenuItem
											variant="destructive"
											onClick={() => void apply(trashFile(org, connectionId, file.id))}
										>
											Move to trash
										</ContextMenuItem>
									</>
								)
							}
						/>
					))}
				</RowList>
			</div>
			{trash && <p className="text-sm text-muted-foreground">{TRASH_NOTE}</p>}
			<Dialog
				open={shown !== null}
				onOpenChange={(next) => {
					if (!next) {
						closeShown();
					}
				}}
			>
				{shown && (
					<ShownFile
						connectionId={connectionId}
						shown={shown}
						onClose={closeShown}
						onRename={(file) => setNaming({file})}
						onMove={setMoving}
					/>
				)}
			</Dialog>
			{moving && (
				<MoveDialog
					key={moving.id}
					connectionId={connectionId}
					file={moving}
					onClose={() => setMoving(null)}
				/>
			)}
			{naming && (
				<RenameDialog
					key={naming.file?.id ?? 'new-folder'}
					open
					title={naming.file ? `Rename ${naming.file.name}` : 'New folder'}
					description={naming.file ? 'Its name, with its extension.' : 'What the folder is called.'}
					initial={naming.file?.name ?? ''}
					allowEmpty={false}
					maxLength={255}
					onClose={() => setNaming(null)}
					onSave={async (name) => {
						const saved = naming.file
							? await renameFile(org, connectionId, naming.file.id, name)
							: await createFolder(org, connectionId, name, folder);
						if (saved.isErr()) {
							return describeApiError(saved.error);
						}
						await reload();
						return null;
					}}
				/>
			)}
		</div>
	);
}

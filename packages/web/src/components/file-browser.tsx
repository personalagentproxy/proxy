import type {DriveFile, FileCrumb, FileDetail, FileList, FileVersion} from '@proxy/contracts/files';
import {FILES_TRASH_DAYS} from '@proxy/integrations';
import {
	ArchiveRestoreIcon,
	ChevronRightIcon,
	DownloadIcon,
	FileIcon,
	FolderIcon,
	FolderPlusIcon,
	ImageIcon,
	LoaderCircleIcon,
	PencilIcon,
	Trash2Icon,
	UploadIcon,
} from 'lucide-react';
import {Fragment, useRef, useState, type DragEvent, type ReactElement, type ReactNode} from 'react';
import {Link, useNavigate} from 'react-router';
import {
	createFolder,
	fileContentPath,
	renameFile,
	restoreFileVersion,
	trashFile,
	untrashFile,
	uploadFile,
	uploadFileVersion,
} from '@/client/files-client';
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
import {Button} from '@proxy/ui/components/button';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';

const EMPTY = 'Nothing here yet. Upload a file, or let your agents put what they make here.';
const EMPTY_TRASH = 'Nothing in the trash.';
const GONE = 'That folder isn’t here any more.';

const TRASH_NOTE = `What is put in the trash is deleted for good after ${FILES_TRASH_DAYS} days.`;

// The table's columns after the name.
const CELLS = {
	size: 'hidden w-20 shrink-0 text-right text-muted-foreground tabular-nums sm:block',
	modified: 'w-28 shrink-0 text-right text-muted-foreground',
};

const LINK = 'underline underline-offset-4 hover:text-foreground';

function FileGlyph({file}: {file: DriveFile}) {
	const Icon = file.folder ? FolderIcon : file.shown ? ImageIcon : FileIcon;
	return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

type IconButtonProps = {
	label: string;
	children: ReactNode;
	disabled?: boolean;
	onClick?: () => void;
	render?: ReactElement;
};

// One of the list's actions, as its icon, named in a tooltip.
function IconButton({label, children, disabled, onClick, render}: IconButtonProps) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
						disabled={disabled}
						onClick={onClick}
						{...(render ? {nativeButton: false, render} : {})}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
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

// Who made a version, as far as it is known: a member, or an agent with the task it was for.
function VersionBy({version}: {version: FileVersion}) {
	const org = useOrgSlug();
	if (version.by === null) {
		return null;
	}
	const {name, task} = version.by;
	return (
		<span className="text-muted-foreground">
			{version.restored ? 'given back by ' : 'by '}
			{name}
			{task && (
				<>
					{' for '}
					<Link to={`/${org}/activity/tasks/${task.id}`} className={LINK}>
						{task.title}
					</Link>
				</>
			)}
		</span>
	);
}

type ShownProps = {
	connectionId: string;
	shown: FileDetail;
	onClose: () => void;
	onRename: (file: DriveFile) => void;
};

// A file opened over its folder: a picture as it is, what the file is, saving it, a new version
// of it, and its versions, newest first, each saved or given back.
function ShownFile({connectionId, shown, onClose, onRename}: ShownProps) {
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
		<DialogContent>
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
						render={<a href={fileContentPath(org, connectionId, file.id)} download={file.name} />}
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
			<div className="flex flex-col gap-1">
				<h3 className="text-sm font-medium">Versions</h3>
				<ul className="flex max-h-64 flex-col overflow-y-auto text-sm">
					{versions.map((version) => (
						<li key={version.id} className="flex min-h-9 items-center gap-2">
							<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
								<span title={formatDateTime(version.at)}>{formatAgo(version.at)}</span>
								<span className="text-muted-foreground tabular-nums">
									{formatBytes(version.size)}
								</span>
								<VersionBy version={version} />
							</span>
							{version.current ? (
								<Badge variant="secondary" className="font-normal">
									Current
								</Badge>
							) : (
								<>
									<Button
										variant="ghost"
										size="sm"
										nativeButton={false}
										render={
											<a
												href={fileContentPath(org, connectionId, file.id, version.id)}
												download={file.name}
											/>
										}
									>
										Download
									</Button>
									{!trashed && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() =>
												void apply(restoreFileVersion(org, connectionId, file.id, version.id))
											}
										>
											Restore
										</Button>
									)}
								</>
							)}
						</li>
					))}
				</ul>
			</div>
		</DialogContent>
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
// in, its folders and files a row each, opened by a click, with what puts more in it: an upload,
// by the button or by dropping files on the list, and a new folder. A file opens over its folder
// with its versions. The trash is a list of its own, each thing in it taken out again.
export function FileBrowser({connectionId, place, list, shown}: Props) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const picker = useRef<HTMLInputElement>(null);
	const [error, setError] = useState<string | null>(null);
	const [uploading, setUploading] = useState(0);
	const [dropping, setDropping] = useState(false);
	const [naming, setNaming] = useState<{file: DriveFile | null} | null>(null);
	const apply = useApply(setError);
	const {folder, trash} = place;
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
		void navigate(driveQuery({folder, trash}), {replace: true, preventScrollReset: true});

	return (
		<div className="flex flex-col gap-2">
			<div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-muted-foreground">
				<Trail trail={list?.trail ?? []} trash={trash} />
				{!trash && list !== null && (
					<span className="ml-auto flex items-center gap-1">
						<IconButton label="Trash" render={<Link to={driveQuery({trash: true})} />}>
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
						<EmptyRows>{trash ? EMPTY_TRASH : EMPTY}</EmptyRows>
					)}
					{files.map((file) => (
						<Row
							key={file.id}
							to={
								file.folder && !trash
									? driveQuery({folder: file.id})
									: driveQuery({folder, trash, file: file.id})
							}
							icon={<FileGlyph file={file} />}
							title={file.name}
							cells={
								<>
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
					/>
				)}
			</Dialog>
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

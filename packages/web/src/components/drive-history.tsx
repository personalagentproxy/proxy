import type {
	DriveChange,
	DriveFileHistory,
	DriveHistoryList,
	DriveVersion,
} from '@proxy/contracts/drive-history';
import type {FetchError} from '@proxy/utils';
import {ExternalLinkIcon, FileIcon, RotateCcwIcon, Undo2Icon} from 'lucide-react';
import {useState} from 'react';
import {useNavigate} from 'react-router';
import {restoreDriveVersion, undoDriveChange} from '@/client/drive-history-client';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {AuthorCell} from '@/components/file-browser';
import {IconButton} from '@/components/icon-button';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {useOrgSlug} from '@/hooks/use-org';
import {useReload} from '@/hooks/use-reload';
import {formatAgo, formatDateTime} from '@/lib/format';
import {describeApiError} from '@/lib/loader-utils';
import {formatBytes} from '@proxy/utils/bytes';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@proxy/ui/components/dialog';
import {cn} from '@proxy/ui/lib/utils';

const EMPTY =
	'No file in Drive has been changed through Personal Agent Proxy yet. Before an agent’s task first changes a file, a copy of it is kept here: a PDF or a picture to give back, a Doc, Sheet or Slides file for agents to read.';

const LINK = 'underline underline-offset-4 hover:text-foreground';

// The list's columns after the name.
const CELLS = {
	change: 'hidden w-48 shrink-0 truncate text-muted-foreground sm:block',
	by: 'hidden w-36 shrink-0 truncate md:block',
	when: 'w-28 shrink-0 text-right text-muted-foreground',
};

// The tables' columns in a file's history: when, what, by whom, and what can be done with it.
const COLUMNS = 'grid grid-cols-[5.5rem_minmax(0,1fr)_minmax(0,13rem)_4.5rem] items-center gap-3';

// What a change did, as a line of the history says it; the list's latest change of a file has no
// more than its kind.
function changeText(
	change: Pick<DriveChange, 'kind'> & Partial<Pick<DriveChange, 'beforeName' | 'cells'>>,
): string {
	if (change.kind === 'create') {
		return 'Made';
	}
	if (change.kind === 'move') {
		return change.beforeName ? `Renamed from “${change.beforeName}”` : 'Renamed';
	}
	if (change.kind === 'trash') {
		return 'Moved to the trash';
	}
	if (change.kind === 'untrash') {
		return 'Taken out of the trash';
	}
	if (change.kind === 'restore') {
		return 'An earlier version given back';
	}
	if (change.kind === 'write') {
		return 'Written over';
	}
	if (change.cells) {
		return `Cells ${change.cells.range} of “${change.cells.tab}” edited`;
	}
	return 'Edited';
}

// What a version is: a copy from before a change, or what a change made.
function versionText(version: DriveVersion): string {
	if (version.origin === 'before') {
		return 'What it held before a change';
	}
	if (version.origin === 'made') {
		return 'An earlier version given back';
	}
	return 'A copy of what it held';
}

// Where a version is kept: its copy here, or only Drive's revision, pinned there or not.
function keptText(version: DriveVersion): string {
	if (version.kept === 'here') {
		return version.size === null ? 'Kept here' : `Kept here · ${formatBytes(version.size)}`;
	}
	return version.pinned ? 'Only in Drive, which keeps it for good meanwhile' : 'Only in Drive';
}

// What an undo is refused with where the cells changed since: in the person's words rather than
// the tool's the api says it in.
function undoRefusal(error: FetchError): string {
	if (error.kind === 'http' && error.status === 409) {
		return 'Those cells changed since, so this change can’t be undone exactly. Give back the version from before it from File > Version history in the sheet instead.';
	}
	return describeApiError(error);
}

// What is asked of the person before it is done.
type Confirming = {kind: 'restore'; version: DriveVersion} | {kind: 'undo'; change: DriveChange};

type ShownProps = {
	history: DriveFileHistory;
	error: string | null;
	onConfirm: (confirming: Confirming) => void;
};

// A file's history over the list: its versions, newest first, each given back where it can be, or
// pointed to in Drive's own version history where only Drive keeps it; and its changes, each by
// whom and for which task, one with an exact undo undone.
function ShownHistory({history, error, onConfirm}: ShownProps) {
	const {file, versions, changes} = history;
	return (
		<DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-3xl">
			<DialogHeader>
				<DialogTitle className="truncate">{file.name}</DialogTitle>
			</DialogHeader>
			<div className="flex items-center gap-2">
				<p className="min-w-0 flex-1 text-sm text-muted-foreground">
					Personal Agent Proxy’s history of it. Drive’s own version history has every revision.
				</p>
				{file.link && (
					<IconButton label="Open in Google Drive" href={file.link}>
						<ExternalLinkIcon />
					</IconButton>
				)}
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<section className="flex min-w-0 flex-col gap-1" aria-label="Versions">
				<h3 className="text-sm font-medium">Versions</h3>
				{versions.length === 0 && (
					<p className="text-sm text-muted-foreground">
						None kept: a copy is kept before a task first changes the file.
					</p>
				)}
				<ul className="flex max-h-72 flex-col overflow-y-auto text-sm">
					{versions.map((version) => (
						<li
							key={version.id}
							className={cn(COLUMNS, 'min-h-12 border-t border-border/60 py-1.5')}
						>
							<span className="text-muted-foreground" title={formatDateTime(version.at)}>
								{formatAgo(version.at)}
							</span>
							<span className="flex min-w-0 flex-col">
								<span className="truncate">{versionText(version)}</span>
								<span className="truncate text-xs text-muted-foreground">{keptText(version)}</span>
								{!version.restorable && file.google && (
									<span className="text-xs text-muted-foreground">
										Give it back from File &gt; Version history in{' '}
										{file.link ? (
											<a href={file.link} target="_blank" rel="noreferrer" className={LINK}>
												the file
											</a>
										) : (
											'the file'
										)}
										, picking the version from that time.
									</span>
								)}
							</span>
							<AuthorCell by={version.by} />
							<span className="flex">
								{version.restorable && (
									<IconButton
										label="Restore this version"
										onClick={() => onConfirm({kind: 'restore', version})}
									>
										<RotateCcwIcon />
									</IconButton>
								)}
							</span>
						</li>
					))}
				</ul>
			</section>
			<section className="flex min-w-0 flex-col gap-1" aria-label="Changes">
				<h3 className="text-sm font-medium">Changes</h3>
				{changes.length === 0 && (
					<p className="text-sm text-muted-foreground">None made through Personal Agent Proxy.</p>
				)}
				<ul className="flex max-h-72 flex-col overflow-y-auto text-sm">
					{changes.map((change) => (
						<li
							key={change.id}
							className={cn(COLUMNS, 'min-h-12 border-t border-border/60 py-1.5')}
						>
							<span className="text-muted-foreground" title={formatDateTime(change.at)}>
								{formatAgo(change.at)}
							</span>
							<span className="truncate" title={changeText(change)}>
								{changeText(change)}
							</span>
							<AuthorCell by={change.by} />
							<span className="flex">
								{change.cells && (
									<IconButton
										label="Undo this change"
										onClick={() => onConfirm({kind: 'undo', change})}
									>
										<Undo2Icon />
									</IconButton>
								)}
							</span>
						</li>
					))}
				</ul>
			</section>
		</DialogContent>
	);
}

/** What a Google connection's page loads of its history in Drive (loaders.ts). */
export type DriveHistoryLoaded = {
	files: DriveHistoryList['files'];
	// The file whose history is shown over the list, as the page's query says, and its history, or
	// why it couldn't be read.
	file: string | null;
	shown: DriveFileHistory | null;
	error: string | null;
};

type Props = {connectionId: string; history: DriveHistoryLoaded};

// The File history part of a Google connection's page: the files in Drive changed through Personal
// Agent Proxy, the latest changed first, each with its latest change, by whom and when; one opens
// over the list with its versions and changes. Giving a version back and undoing a change are asked
// of the person first, and made as theirs.
export function DriveHistory({connectionId, history}: Props) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const reload = useReload();
	const [confirming, setConfirming] = useState<Confirming | null>(null);
	const [error, setError] = useState<string | null>(null);
	const {files, file, shown} = history;
	const opened = (id: string | null) => {
		const params = new URLSearchParams({tab: 'history', ...(id === null ? {} : {file: id})});
		return `?${params.toString()}`;
	};
	const close = () => {
		setError(null);
		void navigate(opened(null), {replace: true, preventScrollReset: true});
	};
	const confirm = async (asked: Confirming) => {
		if (shown === null) {
			return;
		}
		const fileId = shown.file.id;
		const done =
			asked.kind === 'restore'
				? await restoreDriveVersion(org, connectionId, fileId, asked.version.id)
				: await undoDriveChange(org, connectionId, fileId, asked.change.id);
		if (done.isErr()) {
			setError(asked.kind === 'undo' ? undoRefusal(done.error) : describeApiError(done.error));
			return;
		}
		setError(null);
		await reload();
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-sm text-muted-foreground">
				Before an agent’s task first changes a file in Drive, a copy of it is kept: a PDF or a
				picture to give back, a Doc, Sheet or Slides file for agents to read, which Drive’s own
				version history gives back.
			</p>
			{file !== null && history.error && (
				<p className="text-sm text-destructive">{history.error}</p>
			)}
			<RowList
				header={
					<RowHeader>
						<span className="size-4 shrink-0" />
						<span className="min-w-0 flex-1">Name</span>
						<span className={CELLS.change}>Last change</span>
						<span className={CELLS.by}>By</span>
						<span className={CELLS.when}>When</span>
					</RowHeader>
				}
			>
				{files.length === 0 && <EmptyRows>{EMPTY}</EmptyRows>}
				{files.map((one) => (
					<Row
						key={one.id}
						to={opened(one.id)}
						icon={<FileIcon className="size-4 shrink-0 text-muted-foreground" />}
						title={one.name}
						cells={
							<>
								<span className={CELLS.change}>{changeText(one)}</span>
								{/* By name alone: a row is a link, which can't hold the task's. */}
								<span className={CELLS.by}>{one.by?.name ?? 'Unknown'}</span>
								<span className={CELLS.when} title={formatDateTime(one.at)}>
									{formatAgo(one.at)}
								</span>
							</>
						}
					/>
				))}
			</RowList>
			<Dialog
				open={shown !== null}
				onOpenChange={(next) => {
					if (!next) {
						close();
					}
				}}
			>
				{shown && <ShownHistory history={shown} error={error} onConfirm={setConfirming} />}
			</Dialog>
			<ConfirmDialog
				open={confirming !== null}
				title={confirming?.kind === 'undo' ? 'Undo this change?' : 'Restore this version?'}
				description={describeConfirming(confirming, shown)}
				confirmLabel={confirming?.kind === 'undo' ? 'Undo' : 'Restore'}
				onClose={() => setConfirming(null)}
				onConfirm={() => {
					if (confirming !== null) {
						void confirm(confirming);
					}
				}}
			/>
		</div>
	);
}

// What giving a version back or undoing a change does, said before it is done.
function describeConfirming(confirming: Confirming | null, shown: DriveFileHistory | null): string {
	if (confirming === null || shown === null) {
		return '';
	}
	const {file} = shown;
	if (confirming.kind === 'undo') {
		const {cells} = confirming.change;
		const where = cells ? `Cells ${cells.range} of “${cells.tab}”` : 'The cells it wrote';
		return `${where} in “${file.name}” are put back as they were before it. The undo is a change of its own, which can be undone in turn.`;
	}
	return `“${file.name}” gets what this version held as its newest revision in Google Drive. What it holds now is kept as a version first.`;
}

import {
	FileIcon,
	FileSearchIcon,
	FileTextIcon,
	FolderIcon,
	PresentationIcon,
	SheetIcon,
	type LucideIcon,
} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {useFiles, usePeople} from '@/lib/widget-lookups';
import {bestMatch, fileSearch, isAddress, shortDay} from '@/lib/widget-values';

const KIND_ICONS: Partial<Record<string, LucideIcon>> = {
	Document: FileTextIcon,
	Spreadsheet: SheetIcon,
	Presentation: PresentationIcon,
	Folder: FolderIcon,
};

// Find file: what it searches for, from the name, the kind said with it ("deck", "spreadsheet")
// and the owner, found among the contacts for their address, and the files every file store
// finds, each opening where it is.
export function FindFileWidget({intent, typed}: {intent: Intent; typed: string}) {
	const search = fileSearch(intent, typed);
	const ownerName = search.ownerName;
	const people = usePeople(ownerName && !isAddress(ownerName) ? [ownerName] : null);
	const owner = ownerName
		? isAddress(ownerName)
			? ownerName
			: (bestMatch(people.data, ownerName)?.emails[0] ?? null)
		: null;
	// The owner is looked up first: a search without them would only be replaced.
	const files = useFiles(
		ownerName && !owner && people.loading ? null : {words: search.words, kind: search.kind, owner},
	);
	const sources = files.data?.sources ?? [];

	if (files.data && sources.length === 0) {
		return (
			<ConnectWidget icon={FileSearchIcon} name="Find file" collectionId="files">
				Connect Google Drive to find your files from here.
			</ConnectWidget>
		);
	}

	const found = files.data?.files ?? [];
	const described = [
		...(search.words.length > 0 ? [`named ${search.words.join(' ')}`] : []),
		...(search.kind ? [`${search.kind.toLowerCase()}s first`] : []),
		...(ownerName ? [`owned by ${owner ?? ownerName}`] : []),
	];

	return (
		<WidgetFrame icon={FileSearchIcon} name="Find file" failed={files.data?.failed}>
			<p className="truncate">
				<span className="text-muted-foreground">Files </span>
				{described.length === 0 ? <Missing>changed most recently</Missing> : described.join(' · ')}
			</p>
			{found.length > 0 && found.every((file) => file.matched === 'content') && (
				<p className="text-muted-foreground">
					No file is named “{search.words.join(' ')}”; these have it inside.
				</p>
			)}
			{ownerName && !owner && !people.loading && (
				<p className="text-muted-foreground">
					No contact named “{ownerName}”, so files by anyone are shown.
				</p>
			)}
			<ul className="-mx-4 flex flex-col" aria-label="Files">
				{found.length === 0 && (
					<li className="px-4 text-muted-foreground">
						{files.loading || !files.data ? 'Searching…' : 'No files match.'}
					</li>
				)}
				{found.map((file) => {
					const Icon = KIND_ICONS[file.kind] ?? FileIcon;
					const row = (
						<>
							<Icon className="size-4 shrink-0 text-muted-foreground" aria-label={file.kind} />
							<span className="min-w-0 flex-1 truncate">{file.name}</span>
							<span className="hidden w-28 shrink-0 truncate text-muted-foreground md:inline">
								{file.owner}
							</span>
							<span className="shrink-0 text-muted-foreground tabular-nums">
								{file.modified ? shortDay(new Date(file.modified)) : ''}
							</span>
						</>
					);
					return (
						<li key={`${file.connectionId} ${file.id}`}>
							{file.link ? (
								<a
									href={file.link}
									target="_blank"
									rel="noreferrer"
									className="flex h-10 min-w-0 items-center gap-3 px-4 hover:bg-muted"
								>
									{row}
								</a>
							) : (
								<div className="flex h-10 min-w-0 items-center gap-3 px-4">{row}</div>
							)}
						</li>
					);
				})}
			</ul>
		</WidgetFrame>
	);
}

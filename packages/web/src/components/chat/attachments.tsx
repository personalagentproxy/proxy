import type {ChatAttachment} from '@proxy/contracts/harness';
import {formatBytes} from '@proxy/utils/bytes';
import {
	FileArchiveIcon,
	FileCodeIcon,
	FileIcon,
	FileImageIcon,
	FileMusicIcon,
	FilePlayIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	LoaderCircleIcon,
	type LucideIcon,
	PaperclipIcon,
	XIcon,
} from 'lucide-react';
import {Link} from 'react-router';
import {fileContentPath} from '@/client/files-client';
import type {PendingAttachment} from '@/hooks/use-attachments';
import {useOrgSlug} from '@/hooks/use-org';
import {driveQuery, type FileKind, fileKind} from '@/lib/files';
import {cn} from '@proxy/ui/lib/utils';

const KIND_ICONS: Record<FileKind, LucideIcon> = {
	image: FileImageIcon,
	sheet: FileSpreadsheetIcon,
	text: FileTextIcon,
	code: FileCodeIcon,
	archive: FileArchiveIcon,
	audio: FileMusicIcon,
	video: FilePlayIcon,
	file: FileIcon,
};

// A file as a chip: a line of text high, so it sits in a line of a message as a word does, its
// kind in a cell of its own at the front, then its name.
const CHIP = 'flex h-6 max-w-56 min-w-0 items-center rounded-md border bg-background text-sm';
const CELL = 'flex h-full w-6 shrink-0 items-center justify-center border-r text-muted-foreground';
const NAME = 'truncate px-2';
const GLYPH = 'size-3.5';

// A file attached to what the person said, where they put it among their words: a chip, by its
// kind and its name, in the line of the message as a word is, and a link to the file in its
// drive, where it is shown and its versions are.
export function SentChip({attachment}: {attachment: ChatAttachment}) {
	const org = useOrgSlug();
	const {connectionId, fileId, name, type, size} = attachment;
	const Icon = KIND_ICONS[fileKind(name, type)];
	return (
		// With the room a word has around it: padding of its own, the line's text having no gap
		// to give.
		<span className="inline-block px-0.5 py-0.5 align-middle">
			<Link
				to={`/${org}/connections/${connectionId}${driveQuery({file: fileId})}`}
				title={`${name} · ${formatBytes(size)}`}
				// Its own colors, whatever the message's: a message of the person's is drawn inverted.
				className={cn(CHIP, 'text-foreground hover:bg-muted')}
			>
				<span className={CELL}>
					<Icon className={GLYPH} />
				</span>
				<span className={NAME}>{name}</span>
			</Link>
		</span>
	);
}

// A file the persona showed in its answer, where its words put it: a picture as itself, at the
// version kept with the answer, whatever the file holds now, which opens the file in its drive; any
// other file as its chip. As a tile of a gallery, the picture fills a cell of the grid, cut to it.
export function ShownFile({
	attachment,
	alt,
	tile,
}: {
	attachment: ChatAttachment;
	alt: string;
	tile: boolean;
}) {
	const org = useOrgSlug();
	const {connectionId, fileId, version, name, size} = attachment;
	if (!attachment.shown) {
		return <SentChip attachment={attachment} />;
	}
	return (
		<Link
			to={`/${org}/connections/${connectionId}${driveQuery({file: fileId})}`}
			title={`${name} · ${formatBytes(size)}`}
			className={cn(
				'block',
				tile ? 'w-full transition-opacity hover:opacity-85' : 'w-fit max-w-full py-1',
			)}
		>
			<img
				src={fileContentPath(org, connectionId, fileId, version)}
				alt={alt === '' ? name : alt}
				loading="lazy"
				className={cn(
					'rounded-md border bg-background',
					tile ? 'aspect-4/3 w-full rounded-lg object-cover' : 'max-h-96 max-w-full object-contain',
				)}
			/>
		</Link>
	);
}

// A file in the conversation's input, among what is typed (message-editor.tsx): a chip by its
// kind and name, turning while it is on its way up, marked where it failed, and taken out, of the
// message and of the draft the server keeps, by its front cell, which shows a cross under the
// pointer.
export function PendingChip({file, onRemove}: {file: PendingAttachment; onRemove: () => void}) {
	const uploading = file.attachment === null && file.error === null;
	// As the drive called it once it landed there, which is another name where its own was taken.
	const name = file.attachment?.name ?? file.name;
	const Glyph = uploading ? LoaderCircleIcon : KIND_ICONS[fileKind(name, file.attachment?.type)];
	return (
		<span
			title={file.error ?? `${name} · ${formatBytes(file.size)}`}
			className={cn(
				CHIP,
				'group/chip',
				file.error && 'border-destructive text-destructive',
				// In a selection of the message's text, its place is marked as the words beside it are
				// (message-editor.tsx), and the chip is drawn in the marking's colors.
				'group-data-selected/place:border-[color:HighlightText]/30 group-data-selected/place:bg-transparent group-data-selected/place:text-[color:HighlightText]',
			)}
		>
			<button
				type="button"
				onClick={onRemove}
				aria-label={`Remove ${name}`}
				className={cn(
					CELL,
					'rounded-l-md hover:text-foreground',
					file.error && 'border-destructive',
					'group-data-selected/place:border-[color:HighlightText]/30 group-data-selected/place:text-[color:HighlightText]',
				)}
			>
				{/* Its kind, or a turning circle while it is on its way up; under the pointer, the cross
				    that takes it out, whichever it shows. */}
				<Glyph
					className={cn(
						GLYPH,
						uploading && 'animate-spin',
						'group-focus-within/chip:hidden group-hover/chip:hidden',
					)}
				/>
				<XIcon
					className={cn(GLYPH, 'hidden group-focus-within/chip:block group-hover/chip:block')}
				/>
			</button>
			<span className={NAME}>{name}</span>
		</span>
	);
}

// Shown over the whole window while files are dragged across it: wherever they are dropped, they
// are attached to the message.
export function DropToAttach({name}: {name: string}) {
	return (
		<div
			aria-hidden
			className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
		>
			<div className="flex size-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ring">
				<PaperclipIcon className="size-6 text-muted-foreground" />
				<p className="text-lg font-medium">Drop files to attach them</p>
				<p className="text-sm text-muted-foreground">
					They go with your next message to {name}, and are kept in your files.
				</p>
			</div>
		</div>
	);
}

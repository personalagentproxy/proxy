import type {ChatAttachment} from '@proxy/contracts/harness';
import {formatBytes} from '@proxy/utils/bytes';
import {ArrowLeftIcon, ArrowRightIcon, XIcon} from 'lucide-react';
import type {KeyboardEvent} from 'react';
import {Link} from 'react-router';
import {fileContentPath} from '@/client/files-client';
import {FileKindIcon} from '@/components/chat/attachments';
import {useOrgSlug} from '@/hooks/use-org';
import {driveQuery} from '@/lib/files';
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {PillButton} from '@proxy/ui/components/pill-button';
import {pillButtonVariants} from '@proxy/ui/lib/pill-variants';
import {cn} from '@proxy/ui/lib/utils';

/**
 * A file as the viewer shows it: one an answer showed or the person attached, at the version kept
 * with the message, and what the message said it shows, empty where it said nothing.
 */
export type ViewedFile = {attachment: ChatAttachment; alt: string};

// An arrow over an edge of the file: on a light disc of its own, so it shows over any picture.
const STEP = 'absolute top-1/2 -translate-y-1/2 bg-background/85 shadow-sm hover:bg-background';

/**
 * The files of a message in a dialog over the conversation, the one at `index` as large as the
 * window lets it be: a picture whole, any other file as its kind and name, which Files shows; under
 * it what the message said it shows, the file's name and size, where it is among them, and a way
 * to the file in its drive. The others are an arrow, or an arrow key, away. Closed by its cross,
 * Escape or a click beside it, as `index` goes to null.
 */
export function FileViewer({
	files,
	index,
	onIndex,
}: {
	files: ViewedFile[];
	index: number | null;
	onIndex: (index: number | null) => void;
}) {
	const org = useOrgSlug();
	const shown = index === null ? undefined : files[index];
	const many = files.length > 1;
	// One step through the files, round from the last to the first and back.
	const step = (by: number) => {
		if (index === null) {
			return;
		}
		onIndex((index + by + files.length) % files.length);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!many) {
			return;
		}
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			step(-1);
			return;
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault();
			step(1);
		}
	};

	return (
		<Dialog
			open={shown !== undefined}
			onOpenChange={(open) => {
				if (!open) {
					onIndex(null);
				}
			}}
		>
			<DialogContent
				showCloseButton={false}
				onKeyDown={onKeyDown}
				className="gap-3 p-3 sm:max-w-5xl"
			>
				{shown && (
					<>
						<div className="relative flex h-[min(70vh,48rem)] items-center justify-center overflow-hidden rounded-lg bg-muted">
							<Shown key={`${shown.attachment.fileId}-${index}`} file={shown} />
							{many && (
								<>
									<PillButton
										variant="ghost"
										icon
										onClick={() => step(-1)}
										aria-label="Previous file"
										className={cn(STEP, 'left-3')}
									>
										<ArrowLeftIcon />
									</PillButton>
									<PillButton
										variant="ghost"
										icon
										onClick={() => step(1)}
										aria-label="Next file"
										className={cn(STEP, 'right-3')}
									>
										<ArrowRightIcon />
									</PillButton>
								</>
							)}
						</div>
						<div className="flex items-center gap-3 pl-1">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<DialogTitle className="truncate">
									{shown.alt === '' ? shown.attachment.name : shown.alt}
								</DialogTitle>
								<DialogDescription className="truncate">
									{shown.attachment.name} · {formatBytes(shown.attachment.size)}
									{many && ` · ${(index ?? 0) + 1} of ${files.length}`}
								</DialogDescription>
							</div>
							<Link
								to={`/${org}/connections/${shown.attachment.connectionId}${driveQuery({file: shown.attachment.fileId})}`}
								className={pillButtonVariants({variant: 'ghost'})}
							>
								Open in Files
							</Link>
							<DialogClose render={<PillButton variant="ghost" icon aria-label="Close" />}>
								<XIcon />
							</DialogClose>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

// The file the viewer is on: a picture a browser may show, whole; any other file, its kind large
// and its name under it, the viewer's way to Files beneath showing the rest.
function Shown({file}: {file: ViewedFile}) {
	const org = useOrgSlug();
	const {connectionId, fileId, version, name, type, shown} = file.attachment;
	if (shown) {
		return (
			<img
				src={fileContentPath(org, connectionId, fileId, version)}
				alt={file.alt === '' ? name : file.alt}
				className="max-h-full max-w-full object-contain"
			/>
		);
	}
	return (
		<div className="flex max-w-full flex-col items-center gap-3 px-16 text-center">
			<FileKindIcon name={name} type={type} className="size-16 stroke-1 text-muted-foreground" />
			<p className="max-w-full truncate text-sm font-medium">{name}</p>
		</div>
	);
}

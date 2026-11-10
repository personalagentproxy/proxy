import type {ChatAttachment} from '@proxy/contracts/harness';
import {formatBytes} from '@proxy/utils/bytes';
import {FileIcon, LoaderCircleIcon, XIcon} from 'lucide-react';
import {Link} from 'react-router';
import {fileContentPath} from '@/client/files-client';
import type {PendingAttachment} from '@/hooks/use-attachments';
import {useOrgSlug} from '@/hooks/use-org';
import {driveQuery} from '@/lib/files';
import {cn} from '@proxy/ui/lib/utils';

const CHIP =
	'flex max-w-64 min-w-0 items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm';

// The files attached to what the person said, under it: a picture as it is, anything else by its
// name and size, each a link to the file in its drive, where its versions are.
export function Attachments({attachments}: {attachments: ChatAttachment[]}) {
	const org = useOrgSlug();
	if (attachments.length === 0) {
		return null;
	}
	return (
		<div className="flex flex-wrap items-end justify-end gap-2">
			{attachments.map((attachment) => {
				const {connectionId, fileId, version, name, size, shown} = attachment;
				const to = `/${org}/connections/${connectionId}${driveQuery({file: fileId})}`;
				if (shown) {
					return (
						<Link key={`${fileId}-${version}`} to={to} title={name}>
							<img
								src={fileContentPath(org, connectionId, fileId, version)}
								alt={name}
								className="max-h-48 max-w-64 rounded-lg border object-contain"
							/>
						</Link>
					);
				}
				return (
					<Link key={`${fileId}-${version}`} to={to} className={cn(CHIP, 'hover:bg-muted/50')}>
						<FileIcon className="size-4 shrink-0 text-muted-foreground" />
						<span className="truncate">{name}</span>
						<span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(size)}</span>
					</Link>
				);
			})}
		</div>
	);
}

// The files in the conversation's input, above what is typed: each by its name, turning while it
// is on its way up, saying why where it failed, and taken out again by its cross.
export function PendingAttachments({
	pending,
	onRemove,
}: {
	pending: PendingAttachment[];
	onRemove: (key: number) => void;
}) {
	if (pending.length === 0) {
		return null;
	}
	return (
		<ul className="flex flex-wrap gap-2" aria-label="Attached files">
			{pending.map((one) => (
				<li key={one.key} className={cn(CHIP, one.error && 'border-destructive')}>
					{one.attachment === null && one.error === null ? (
						<LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />
					) : (
						<FileIcon className="size-4 shrink-0 text-muted-foreground" />
					)}
					<span className="flex min-w-0 flex-col">
						<span className="truncate">{one.name}</span>
						{one.error && <span className="text-xs text-destructive">{one.error}</span>}
					</span>
					{!one.error && (
						<span className="shrink-0 text-muted-foreground tabular-nums">
							{formatBytes(one.size)}
						</span>
					)}
					<button
						type="button"
						onClick={() => onRemove(one.key)}
						aria-label={`Remove ${one.name}`}
						className="shrink-0 rounded text-muted-foreground hover:text-foreground"
					>
						<XIcon className="size-3.5" />
					</button>
				</li>
			))}
		</ul>
	);
}

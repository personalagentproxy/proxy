import type {WriteStatus} from '@/lib/write-status';

// What a widget's write did, beside its buttons; nothing before it writes.
export function WriteResult({status}: {status: WriteStatus}) {
	if (status.kind === 'saving') {
		return <>Working…</>;
	}
	if (status.kind === 'failed') {
		return <span className="text-destructive">{status.message}</span>;
	}
	if (status.kind === 'done') {
		return (
			<span className="text-foreground">
				{status.message}
				{status.link && (
					<>
						{' · '}
						<a href={status.link} target="_blank" rel="noreferrer" className="underline">
							Open
						</a>
					</>
				)}
			</span>
		);
	}
	return null;
}

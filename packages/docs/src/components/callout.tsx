import {InfoIcon, TriangleAlertIcon} from 'lucide-react';
import type {ReactNode} from 'react';
import {cn} from '@proxy/ui/lib/utils';

type Props = {
	// A warning is for what loses data or locks people out; a note for everything else.
	type?: 'note' | 'warning';
	children: ReactNode;
};

export function Callout({type = 'note', children}: Props) {
	const Icon = type === 'warning' ? TriangleAlertIcon : InfoIcon;

	return (
		<div
			className={cn(
				'my-5 flex gap-3 rounded-lg border px-4 py-3 text-sm leading-6 [&>div>p]:my-0',
				type === 'warning' && 'border-destructive/30 bg-destructive/5',
				type === 'note' && 'bg-muted/40',
			)}
		>
			<Icon
				className={cn(
					'mt-1 size-4 shrink-0',
					type === 'warning' ? 'text-destructive' : 'text-muted-foreground',
				)}
			/>
			<div className="min-w-0 space-y-2">{children}</div>
		</div>
	);
}

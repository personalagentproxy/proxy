import {CircleCheckIcon} from 'lucide-react';
import type {ReactNode} from 'react';

// The green line a page shows right after something worked, such as a connection being added.
export function SuccessLine({children}: {children: ReactNode}) {
	return (
		<p className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
			<CircleCheckIcon className="size-4 shrink-0" />
			{children}
		</p>
	);
}

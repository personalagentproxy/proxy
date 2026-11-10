import {CornerDownLeftIcon} from 'lucide-react';
import {cn} from '@proxy/ui/lib/utils';

// Enter does it: after a `PillButton`'s label (its `enter`), or on the command bar's lit row.
// Beside a label it is small and muted; `alone`, as the whole of a button, at an icon's size and
// full strength.
export function EnterHint({alone = false}: {alone?: boolean}) {
	return <CornerDownLeftIcon aria-hidden className={cn(alone ? 'size-4' : 'size-3 opacity-60')} />;
}

import {ArrowLeftIcon} from 'lucide-react';
import {Link} from 'react-router';
import type {Back} from '@/lib/back';
import {Button} from '@proxy/ui/components/button';

// The arrow at the left of a detail screen's header, leading back to the list it came from, or to
// `to` with `state` where the screen knows where it came from (lib/back.ts).
export function BackButton({to, label, state}: {to: string; label: string; state?: Back | null}) {
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			nativeButton={false}
			render={<Link to={to} state={state} />}
		>
			<ArrowLeftIcon />
			<span className="sr-only">{label}</span>
		</Button>
	);
}

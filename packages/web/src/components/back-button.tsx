import {ArrowLeftIcon} from 'lucide-react';
import {Link} from 'react-router';
import {Button} from '@/components/ui/button';

// The arrow at the left of a detail screen's header, leading back to the list it came from.
export function BackButton({to, label}: {to: string; label: string}) {
	return (
		<Button variant="ghost" size="icon-sm" nativeButton={false} render={<Link to={to} />}>
			<ArrowLeftIcon />
			<span className="sr-only">{label}</span>
		</Button>
	);
}

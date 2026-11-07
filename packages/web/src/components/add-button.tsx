import {PlusIcon} from 'lucide-react';
import {Link} from 'react-router';
import {IconButton} from '@/components/icon-button';
import {InTitleBar} from '@/components/title-bar-slot';
import {Button} from '@proxy/ui/components/button';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';

type Props = {
	label: string;
	variant?: 'default' | 'outline';
} & ({to: string; onClick?: never} | {onClick: () => void; to?: never});

// A header's add action. In a browser, a button with its label. In the desktop app, a plus alone
// in the title bar beside back and forward, as they are, with its label in a tooltip.
export function AddButton({label, variant = 'default', to, onClick}: Props) {
	if (hasHiddenDesktopTitleBar()) {
		const icon = <PlusIcon className="size-4" />;
		return (
			<InTitleBar place="controls">
				{to !== undefined ? (
					<IconButton label={label} size="xs" to={to}>
						{icon}
					</IconButton>
				) : (
					<IconButton label={label} size="xs" onClick={onClick}>
						{icon}
					</IconButton>
				)}
			</InTitleBar>
		);
	}

	const content = (
		<>
			<PlusIcon data-icon="inline-start" />
			{label}
		</>
	);
	if (to !== undefined) {
		return (
			<Button size="sm" variant={variant} nativeButton={false} render={<Link to={to} />}>
				{content}
			</Button>
		);
	}
	return (
		<Button size="sm" variant={variant} onClick={onClick}>
			{content}
		</Button>
	);
}

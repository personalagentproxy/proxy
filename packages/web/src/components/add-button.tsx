import {PlusIcon} from 'lucide-react';
import {Link} from 'react-router';
import {PillButton} from '@proxy/ui/components/pill-button';
import {type Shortcut, ShortcutHint} from '@/components/shortcut-hint';

type Props = {
	label: string;
	variant?: 'default' | 'ghost';
	className?: string;
	// The keyboard's way to it, after its label.
	shortcut?: Shortcut;
} & ({to: string; onClick?: never} | {onClick: () => void; to?: never});

// A list's add action: a button with a plus and its label, at the right of the bar over the list,
// or across the foot of Chat's agents and of an agent's tasks.
export function AddButton({label, variant = 'default', className, shortcut, to, onClick}: Props) {
	const content = (
		<>
			<PlusIcon data-icon="inline-start" />
			{label}
			{shortcut !== undefined && <ShortcutHint {...shortcut} />}
		</>
	);
	if (to !== undefined) {
		return (
			<PillButton
				variant={variant}
				className={className}
				nativeButton={false}
				render={<Link to={to} />}
			>
				{content}
			</PillButton>
		);
	}
	return (
		<PillButton variant={variant} className={className} onClick={onClick}>
			{content}
		</PillButton>
	);
}

import {PlusIcon} from 'lucide-react';
import {Link} from 'react-router';
import {PillButton} from '@proxy/ui/components/pill-button';

type Props = {
	label: string;
	variant?: 'default' | 'ghost';
	className?: string;
} & ({to: string; onClick?: never} | {onClick: () => void; to?: never});

// A list's add action: a button with a plus and its label, at the right of the bar over the list,
// or across the foot of Chat's agents.
export function AddButton({label, variant = 'default', className, to, onClick}: Props) {
	const content = (
		<>
			<PlusIcon data-icon="inline-start" />
			{label}
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

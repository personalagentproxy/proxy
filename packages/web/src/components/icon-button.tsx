import type {ReactNode} from 'react';
import {Link} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';

type Props = {
	label: string;
	children: ReactNode;
	disabled?: boolean;
} & ({onClick: () => void; to?: never} | {to: string; onClick?: never});

// A header's icon action: a ghost icon button with its label in a tooltip.
export function IconButton({label, children, disabled = false, onClick, to}: Props) {
	const button =
		to === undefined ? (
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={label}
				disabled={disabled}
				onClick={onClick}
			/>
		) : (
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={label}
				nativeButton={false}
				render={<Link to={to} />}
			/>
		);

	return (
		<Tooltip>
			<TooltipTrigger render={button}>{children}</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

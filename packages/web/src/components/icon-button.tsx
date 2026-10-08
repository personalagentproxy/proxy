import type {ReactNode} from 'react';
import {Link} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';

type Props = {
	label: string;
	children: ReactNode;
	disabled?: boolean;
	size?: 'xs' | 'sm';
} & (
	| {onClick: () => void; to?: never; href?: never}
	| {to: string; onClick?: never; href?: never}
	// A full navigation, such as to an api route that sends the browser on to a sign-in.
	| {href: string; onClick?: never; to?: never}
);

// A header's icon action: a ghost icon button with its label in a tooltip.
export function IconButton({
	label,
	children,
	disabled = false,
	size = 'sm',
	onClick,
	to,
	href,
}: Props) {
	const buttonSize = size === 'xs' ? 'icon-xs' : 'icon-sm';
	const button =
		to !== undefined ? (
			<Button
				variant="ghost"
				size={buttonSize}
				aria-label={label}
				nativeButton={false}
				render={<Link to={to} />}
			/>
		) : href !== undefined ? (
			<Button
				variant="ghost"
				size={buttonSize}
				aria-label={label}
				nativeButton={false}
				render={<a href={href} />}
			/>
		) : (
			<Button
				variant="ghost"
				size={buttonSize}
				aria-label={label}
				disabled={disabled}
				onClick={onClick}
			/>
		);

	return (
		<Tooltip>
			<TooltipTrigger render={button}>{children}</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

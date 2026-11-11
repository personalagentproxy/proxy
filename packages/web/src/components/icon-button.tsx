import type {MouseEvent, ReactNode} from 'react';
import {Link} from 'react-router';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {PillButton} from '@proxy/ui/components/pill-button';

type Props = {
	label: string;
	children: ReactNode;
	disabled?: boolean;
} & (
	| {onClick: () => void; to?: never; href?: never}
	| {to: string; onClick?: never; href?: never}
	// A full navigation, such as to an api route that sends the browser on to a sign-in, with what
	// the desktop app does with it instead (`onSignInClick`).
	| {href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void; to?: never}
);

// A header's icon action: a ghost pill that is an icon alone, a circle, with its label in a tooltip.
export function IconButton({label, children, disabled = false, onClick, to, href}: Props) {
	const button =
		to !== undefined ? (
			<PillButton
				variant="ghost"
				icon
				aria-label={label}
				nativeButton={false}
				render={<Link to={to} />}
			/>
		) : href !== undefined ? (
			<PillButton
				variant="ghost"
				icon
				aria-label={label}
				nativeButton={false}
				render={<a href={href} onClick={onClick} />}
			/>
		) : (
			<PillButton variant="ghost" icon aria-label={label} disabled={disabled} onClick={onClick} />
		);

	return (
		<Tooltip>
			<TooltipTrigger render={button}>{children}</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

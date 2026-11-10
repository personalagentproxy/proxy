import type {ReactNode} from 'react';
import {Button, buttonVariants} from '@proxy/ui/components/button';
import {EnterHint} from '@/components/widgets/enter-hint';
import {type BarAction, useBarAction} from '@/hooks/use-bar-action';

// A widget's main button, the dark one: Enter in the command bar's input presses it while it can
// be pressed, and it says so, unless the bar lists somewhere to go, which Enter opens instead.
// Where Enter was pressed before the widget showed, the bar says whether it is pressed at once
// (`bar.entered`): for an agent to make, never for what writes to the person's accounts.
export function EnterButton({
	bar,
	onClick,
	disabled = false,
	children,
}: {
	bar: BarAction;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	useBarAction(bar, onClick, !disabled);
	return (
		<Button size="sm" onClick={onClick} disabled={disabled}>
			{children}
			{bar.onEnter && <EnterHint />}
		</Button>
	);
}

/** A widget's main button that opens something elsewhere, in a tab of its own: Enter opens it too. */
export function EnterLink({
	bar,
	href,
	children,
}: {
	bar: BarAction;
	href: string;
	children: ReactNode;
}) {
	useBarAction(bar, () => window.open(href, '_blank', 'noreferrer'), true);
	return (
		<a href={href} target="_blank" rel="noreferrer" className={buttonVariants({size: 'sm'})}>
			{children}
			{bar.onEnter && <EnterHint />}
		</a>
	);
}

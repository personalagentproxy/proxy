import type {LucideIcon} from 'lucide-react';
import type {ReactNode} from 'react';
import type {Failure} from '@/client/widgets-client';
import {initials} from '@/lib/widget-values';

type Props = {
	icon: LucideIcon;
	name: string;
	children: ReactNode;
	// Its buttons, the main one last.
	actions?: ReactNode;
	// What its last write did, or why it failed, beside its buttons.
	status?: ReactNode;
	// The connections it couldn't read, which it shows without.
	failed?: Failure[];
};

// One widget, as the home page's input card opens into it: what it is, what it found, and its
// buttons. The card draws the border, and its rows reach it.
export function WidgetFrame({icon: Icon, name, children, actions, status, failed = []}: Props) {
	return (
		<section aria-label={name} className="flex flex-col gap-4 p-4 text-sm [--bleed:--spacing(4)]">
			<header className="flex items-center gap-2 text-muted-foreground">
				<Icon className="size-4" />
				{name}
			</header>
			{children}
			{failed.length > 0 && (
				<ul className="flex flex-col gap-1 text-muted-foreground" aria-label="Not read">
					{failed.map((failure) => (
						<li key={failure.connectionId} className="truncate">
							Couldn’t read {failure.account}: {failure.message}
						</li>
					))}
				</ul>
			)}
			{(status || actions) && (
				<footer className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0 text-muted-foreground">{status}</div>
					{actions && <div className="flex gap-2">{actions}</div>}
				</footer>
			)}
		</section>
	);
}

export function Avatar({name, large}: {name: string; large?: boolean}) {
	return (
		<span
			aria-hidden
			className={`flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ${large ? 'size-12' : 'size-7'}`}
		>
			{initials(name)}
		</span>
	);
}

// A labelled line of a widget: its icon, then what it is.
export function DetailRow({icon: Icon, children}: {icon: LucideIcon; children: ReactNode}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1 truncate">{children}</div>
		</div>
	);
}

// Nothing filled yet, in the place the value goes.
export function Missing({children}: {children: ReactNode}) {
	return <span className="text-muted-foreground">{children}</span>;
}

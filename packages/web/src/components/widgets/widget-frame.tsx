import type {LucideIcon} from 'lucide-react';
import type {ComponentProps, ReactNode} from 'react';
import {Input} from '@proxy/ui/components/input';
import {Textarea} from '@proxy/ui/components/textarea';
import {cn} from '@proxy/ui/lib/utils';
import type {Failure} from '@/client/widgets-client';
import {initials} from '@/lib/widget-values';

type Props = {
	name: string;
	// What it shows; none for a widget that is only its foot, as a message to an agent is.
	children?: ReactNode;
	// Its buttons, the main one last.
	actions?: ReactNode;
	// What its last write did, or why it failed, beside its buttons, in small print, which takes
	// what room they leave.
	status?: ReactNode;
	// The connections it couldn't read, which it shows without.
	failed?: Failure[];
};

// One widget, as the command bar opens into it, in the manner of Chat's message box: one surface
// with the input, no line between them and no heading, since what it shows and what its buttons
// say tell what it is; `name` is what it is called to whoever can't see it. At its foot, what its
// last write did beside its buttons, pills as the button that sends a message is. The bar draws
// the surface, as Chat's box (lib/pill-variants.ts), and the widget's rows reach its edge.
export function WidgetFrame({name, children, actions, status, failed = []}: Props) {
	return (
		<section
			aria-label={name}
			className="flex flex-col gap-3 px-4 pb-3 text-sm [--bleed:--spacing(4)]"
		>
			{children}
			{failed.length > 0 && (
				<ul className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="Not read">
					{failed.map((failure) => (
						<li key={failure.connectionId} className="truncate">
							Couldn’t read {failure.account}: {failure.message}
						</li>
					))}
				</ul>
			)}
			{(status || actions) && (
				<footer className="flex flex-wrap items-center justify-between gap-3">
					<div className="min-w-0 flex-1 text-xs text-muted-foreground">{status}</div>
					{actions && <div className="flex gap-1.5">{actions}</div>}
				</footer>
			)}
		</section>
	);
}

// What a field of a widget has in place of a box of its own, as the message in Chat's box has
// none: only what is typed, or what to type.
const BARE =
	'rounded-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 dark:bg-transparent';

/** A widget's one-line field: what is typed in it, on the widget's own surface. */
export function WidgetInput({className, ...props}: ComponentProps<typeof Input>) {
	return <Input className={cn('h-6', BARE, className)} {...props} />;
}

/** A widget's field of several lines, as tall as what is typed in it. */
export function WidgetTextarea({className, ...props}: ComponentProps<typeof Textarea>) {
	return <Textarea className={cn('min-h-0 resize-none', BARE, className)} {...props} />;
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

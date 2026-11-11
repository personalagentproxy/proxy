import type {ComponentProps} from 'react';
import {Button} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import {EnterHint} from '@proxy/ui/components/enter-hint';
import {type PillVariant, pillClasses} from '@proxy/ui/lib/pill-variants';

/**
 * The app's button: round, solid and dark for the main action, ghost for any other (Cancel), red
 * (`destructive`) where it deletes or removes something. A ghost one is also a toggle's option or
 * a tab, filled in where it is chosen (`aria-pressed`, or `aria-current` on a link). With a label
 * it has no icon of its own; `icon` makes it an icon alone, in a circle, its label for whoever
 * can't see it in `aria-label` (`IconButton` adds the tooltip). Where Enter presses it, `enter`
 * puts Enter's mark after its label, as on the command bar's cards (`EnterButton`); Chat's send
 * button is the mark alone, in a circle. A link drawn as one takes `pillVariants`
 * (lib/pill-variants.ts, which says which corners the rest of the app has).
 */
export function PillButton({
	variant = 'default',
	enter = false,
	icon = false,
	className,
	children,
	...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size'> & {
	variant?: PillVariant;
	enter?: boolean;
	icon?: boolean;
}) {
	// Enter's mark with no label: a circle around it.
	const alone = enter && (children === undefined || children === null);
	return (
		<Button
			size={alone || icon ? 'icon-sm' : 'sm'}
			variant={variant}
			className={cn(pillClasses(variant), className)}
			{...props}
		>
			{children}
			{enter && <EnterHint alone={alone} />}
		</Button>
	);
}

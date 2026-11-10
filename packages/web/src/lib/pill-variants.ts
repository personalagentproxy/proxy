import {buttonVariants} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';

/** What a `PillButton` (components/pill-button.tsx) can be: the main action, any other, or red. */
export type PillVariant = 'default' | 'ghost' | 'destructive';

// What makes a button of the app's a pill; a ghost one that is chosen, a toggle's option pressed
// (`aria-pressed`) or a tab open (`aria-current` on a link, `aria-selected` in a tablist), filled
// in as it is under the pointer.
export function pillClasses(variant: PillVariant): string {
	return cn(
		'rounded-full',
		variant === 'ghost' &&
			'aria-pressed:bg-muted aria-pressed:text-foreground aria-selected:bg-muted aria-selected:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground',
	);
}

/** The classes of a `PillButton` of `variant`, for a link drawn as one. */
export function pillVariants({variant = 'default'}: {variant?: PillVariant} = {}): string {
	return cn(buttonVariants({variant, size: 'sm'}), pillClasses(variant));
}

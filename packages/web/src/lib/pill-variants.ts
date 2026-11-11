import {buttonVariants} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';

/**
 * The app's corners, one for each kind of thing, so a screen reads as one:
 * - what is pressed is a pill, `rounded-full`: buttons, links drawn as buttons, icon buttons, a
 *   toggle's options, tabs, and the pickers in a line ("Send this to General", a widget's calendar,
 *   Chat's model);
 * - a row of a list, lit as it is pointed at or chosen, `rounded-lg`: the sidebar's, Chat's
 *   conversations, the command bar's;
 * - a surface, `rounded-xl`: a card, a dialog, Chat's message box and the command bar drawn as it;
 * - a small tile, `rounded-md`: an integration's logo, an event in a day's grid.
 */

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

/** The classes of a `PillButton` of `variant`, for a link drawn as one; `icon` for one that is an icon alone, a circle. */
export function pillVariants({
	variant = 'default',
	icon = false,
}: {variant?: PillVariant; icon?: boolean} = {}): string {
	return cn(buttonVariants({variant, size: icon ? 'icon-sm' : 'sm'}), pillClasses(variant));
}

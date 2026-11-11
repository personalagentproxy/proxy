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

// Every pill: its shape, its type, its focus ring, its icons' size, and how it looks pressed,
// turned off or invalid.
const BASE =
	"inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

// Each variant's colors. A ghost one that is chosen, a toggle's option pressed (`aria-pressed`) or a
// tab open (`aria-current` on a link, `aria-selected` in a tablist), is filled in as it is under
// the pointer.
const VARIANTS: Record<PillVariant, string> = {
	default: 'bg-primary text-primary-foreground hover:bg-primary/80',
	ghost:
		'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 aria-pressed:bg-muted aria-pressed:text-foreground aria-selected:bg-muted aria-selected:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground',
	destructive:
		'bg-destructive text-white hover:bg-destructive/90 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
};

// One with a label, with room for an icon at either end of it; one that is an icon alone, a circle.
const LABEL = 'h-8 gap-1 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2';
const ICON = 'size-8';

/** The classes of a `PillButton` of `variant`, for a link drawn as one; `icon` for one that is an icon alone, a circle. */
export function pillVariants({
	variant = 'default',
	icon = false,
}: {variant?: PillVariant; icon?: boolean} = {}): string {
	return cn(BASE, VARIANTS[variant], icon ? ICON : LABEL);
}

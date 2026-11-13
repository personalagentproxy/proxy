import {cn} from '@proxy/ui/lib/utils';

/**
 * The app's corners, one for each kind of thing, so a screen reads as one:
 * - what is pressed is a pill, `rounded-full`: buttons, links drawn as buttons, icon buttons, a
 *   toggle's options, tabs, the pickers in a line ("Send this to General", a widget's calendar,
 *   Chat's model), and the web app's navigation, the organization switcher and the pages under it;
 * - a row of a list, lit as it is pointed at or chosen, `rounded-lg`: Chat's conversations, the
 *   command bar's, the docs' sidebar's;
 * - a surface, `rounded-xl`: a card, a dialog, Chat's message box and the command bar drawn as it;
 * - a small tile, `rounded-md`: an integration's logo, an event in a day's grid.
 *
 * A pill is a button (`PillButton`, `pillButtonVariants`), which sinks a pixel as it is pressed, or
 * a tab (`PillTab`, `pillTabVariants`): a tab, or a toggle's option, which stays put and is filled
 * in where it is chosen.
 */

/**
 * What a `PillButton` (components/pill-button.tsx) can be: the main action, a second way forward
 * beside it, any other, or red. `outline` is used sparingly: a test keeps a list of where.
 */
export type PillButtonVariant = 'default' | 'outline' | 'ghost' | 'destructive';

// Every pill, button or tab: its shape, its type, its focus ring, its icons' size, and how it looks
// turned off or invalid.
const PILL =
	"inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

// A button sinks a pixel as it is pressed, unless it opens a menu.
const SINKS = 'active:not-aria-[haspopup]:translate-y-px';

// Each button's colors. A ghost one whose menu is open is filled in as it is under the pointer.
const BUTTON_VARIANTS: Record<PillButtonVariant, string> = {
	default: 'bg-primary text-primary-foreground hover:bg-primary/80',
	outline:
		'border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
	ghost:
		'hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50',
	destructive:
		'bg-destructive text-white hover:bg-destructive/90 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
};

// A tab: its label alone, filled in as it is under the pointer and where it is chosen
// (`data-chosen`).
const TAB =
	'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 data-chosen:bg-muted data-chosen:text-foreground';

// One with a label, with room for an icon at either end of it; one that is an icon alone, a circle.
const LABEL = 'h-8 gap-1 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2';
const ICON = 'size-8';

/** The classes of a `PillButton` of `variant`, for a link drawn as one; `icon` for one that is an icon alone, a circle. */
export function pillButtonVariants({
	variant = 'default',
	icon = false,
}: {variant?: PillButtonVariant; icon?: boolean} = {}): string {
	return cn(PILL, SINKS, BUTTON_VARIANTS[variant], icon ? ICON : LABEL);
}

/** The classes of a `PillTab` (components/pill-tab.tsx); `icon` for one that is an icon alone, a circle. */
export function pillTabVariants({icon = false}: {icon?: boolean} = {}): string {
	return cn(PILL, TAB, icon ? ICON : LABEL);
}

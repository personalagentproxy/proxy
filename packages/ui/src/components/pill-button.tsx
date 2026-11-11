import {Button as ButtonPrimitive} from '@base-ui/react/button';
import {cn} from '@proxy/ui/lib/utils';
import {EnterHint} from '@proxy/ui/components/enter-hint';
import {type PillVariant, pillVariants} from '@proxy/ui/lib/pill-variants';

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
}: ButtonPrimitive.Props & {
	variant?: PillVariant;
	enter?: boolean;
	icon?: boolean;
}) {
	// Enter's mark with no label: a circle around it.
	const alone = enter && (children === undefined || children === null);
	return (
		<ButtonPrimitive className={cn(pillVariants({variant, icon: alone || icon}), className)} {...props}>
			{children}
			{enter && <EnterHint alone={alone} />}
		</ButtonPrimitive>
	);
}

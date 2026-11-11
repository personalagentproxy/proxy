import {Button as ButtonPrimitive} from '@base-ui/react/button';
import {cn} from '@proxy/ui/lib/utils';
import {pillTabVariants} from '@proxy/ui/lib/pill-variants';

/**
 * A tab, or a toggle's option: a pill of its label alone, filled in where it is `chosen`, and,
 * unlike a `PillButton`, staying put as it is pressed. How it looks comes from `chosen` alone; what
 * it is for a screen reader comes from where it is, so it takes that as its own: `aria-pressed` for
 * a toggle's option, `role="tab"` and `aria-selected` in a tablist, `aria-current="page"` on a link
 * (`render={<Link />}`, with `nativeButton={false}`). `icon` makes it an icon alone, in a circle.
 */
export function PillTab({
	chosen,
	icon = false,
	className,
	...props
}: ButtonPrimitive.Props & {
	chosen: boolean;
	icon?: boolean;
}) {
	return (
		<ButtonPrimitive
			data-chosen={chosen || undefined}
			className={cn(pillTabVariants({icon}), className)}
			{...props}
		/>
	);
}

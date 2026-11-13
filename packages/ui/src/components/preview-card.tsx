'use client';

import {PreviewCard as PreviewCardPrimitive} from '@base-ui/react/preview-card';
import {cn} from '@proxy/ui/lib/utils';

function PreviewCard(props: PreviewCardPrimitive.Root.Props) {
	return <PreviewCardPrimitive.Root data-slot="preview-card" {...props} />;
}

function PreviewCardTrigger(props: PreviewCardPrimitive.Trigger.Props) {
	return <PreviewCardPrimitive.Trigger data-slot="preview-card-trigger" {...props} />;
}

// The card that opens over a link when the pointer rests on it. Unlike a tooltip it can be
// entered, so what it shows can be read and its link followed.
function PreviewCardContent({
	className,
	side = 'bottom',
	sideOffset = 8,
	align = 'start',
	alignOffset = 0,
	children,
	...props
}: PreviewCardPrimitive.Popup.Props &
	Pick<PreviewCardPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
	return (
		<PreviewCardPrimitive.Portal>
			<PreviewCardPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				side={side}
				sideOffset={sideOffset}
				className="isolate z-50"
			>
				<PreviewCardPrimitive.Popup
					data-slot="preview-card-content"
					className={cn(
						'z-50 w-80 max-w-[calc(100vw-2rem)] origin-(--transform-origin) overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
						className,
					)}
					{...props}
				>
					{children}
				</PreviewCardPrimitive.Popup>
			</PreviewCardPrimitive.Positioner>
		</PreviewCardPrimitive.Portal>
	);
}

export {PreviewCard, PreviewCardTrigger, PreviewCardContent};


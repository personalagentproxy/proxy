import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {type TitleBarSlots, useTitleBarSlot} from '@/hooks/use-title-bar-slot';

// Renders `children` in the desktop app's title bar, after back and forward: in `place`, the
// page's controls or, after them, its title. Nothing where there is no title bar.
export function InTitleBar({place, children}: {place: keyof TitleBarSlots; children: ReactNode}) {
	const slot = useTitleBarSlot(place);
	if (!slot) {
		return null;
	}
	return createPortal(children, slot);
}

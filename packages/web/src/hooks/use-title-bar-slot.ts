import {createContext, useContext} from 'react';

// The desktop app's title bar's slots for a page (desktop-history.tsx): its controls, after back
// and forward, then its title. Null in a browser, and until the title bar is drawn.
export type TitleBarSlots = {controls: HTMLElement | null; title: HTMLElement | null};

export const TitleBarSlot = createContext<TitleBarSlots>({controls: null, title: null});

export function useTitleBarSlot(place: keyof TitleBarSlots): HTMLElement | null {
	return useContext(TitleBarSlot)[place];
}

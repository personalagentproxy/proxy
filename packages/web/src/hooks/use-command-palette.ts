import {createContext, useContext, useEffect} from 'react';

/**
 * The command bar over any page (components/command-palette.tsx): opening it, and a page with the
 * bar on it already, as Home, saying so, so that opening it leads there instead.
 */
export type CommandPalette = {
	// Opens the bar, or closes it where it is open: over the page, or the page's own where it has one.
	toggle: () => void;
	// The page's own bar and how it takes the cursor; null as the page leaves.
	setOwn: (focus: (() => void) | null) => void;
};

export const CommandPaletteContext = createContext<CommandPalette>({
	toggle: () => undefined,
	setOwn: () => undefined,
});

export function useCommandPalette(): CommandPalette {
	return useContext(CommandPaletteContext);
}

/** A page's own command bar, which takes the cursor with `focus` where the bar is asked for. */
export function useOwnCommandBar(focus: () => void, own: boolean) {
	const {setOwn} = useCommandPalette();
	useEffect(() => {
		if (!own) {
			return;
		}
		setOwn(focus);
		return () => setOwn(null);
	}, [focus, own, setOwn]);
}

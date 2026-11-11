import {createContext, useContext} from 'react';

/** The command bar over any page (components/command-palette.tsx), for opening it. */
export type CommandPalette = {
	// Opens the bar over the page, or closes it where it is open.
	toggle: () => void;
};

export const CommandPaletteContext = createContext<CommandPalette>({
	toggle: () => undefined,
});

export function useCommandPalette(): CommandPalette {
	return useContext(CommandPaletteContext);
}

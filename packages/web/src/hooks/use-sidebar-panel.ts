import {createContext, useContext} from 'react';

// What a page puts in the sidebar in the navigation's place, as Chat its agents: the sidebar
// drills into it while the page is open (nav.tsx), with a way back up to the navigation, which
// shows it without leaving the page; the page's own item in it drills back in. Gone with the page.
export type SidebarPanel = {
	// Where the page's panel goes: one node for as long as the human side is open, which the
	// sidebar holds (components/sidebar-panel.tsx), shown while it is drilled in.
	slot: HTMLElement;
	// What the open page's panel is called, as its item in the navigation is; null without one.
	label: string | null;
	setLabel: (label: string | null) => void;
	// Whether the person went back up to the navigation from it.
	up: boolean;
	setUp: (up: boolean) => void;
	// Whether a panel opening now leaves the sidebar up on the navigation: in an organization just
	// switched to, until the person goes elsewhere in it.
	opensUp: () => boolean;
};

export const SidebarPanelContext = createContext<SidebarPanel | null>(null);

export function useSidebarPanel(): SidebarPanel {
	const context = useContext(SidebarPanelContext);
	if (!context) {
		throw new Error('useSidebarPanel must be used within a SidebarPanelProvider.');
	}
	return context;
}

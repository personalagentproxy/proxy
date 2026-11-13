import {type ReactNode, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {useSidebar} from '@proxy/ui/components/sidebar';
import {SidebarPanelContext, useSidebarPanel} from '@/hooks/use-sidebar-panel';

// The sidebar's panel for the human side's pages (hooks/use-sidebar-panel.ts).
export function SidebarPanelProvider({children}: {children: ReactNode}) {
	const [slot] = useState(() => {
		const node = document.createElement('div');
		node.className = 'contents';
		return node;
	});
	const [label, setLabel] = useState<string | null>(null);
	const [up, setUp] = useState(false);
	const value = useMemo(() => ({slot, label, setLabel, up, setUp}), [slot, label, up]);
	return <SidebarPanelContext value={value}>{children}</SidebarPanelContext>;
}

/**
 * From a page: `children` in the sidebar, in the navigation's place, while the page is open, under
 * a way back up named `label`.
 */
export function InSidebar({label, children}: {label: string; children: ReactNode}) {
	const {slot, setLabel, setUp} = useSidebarPanel();
	const {setOpenMobile} = useSidebar();
	// Before the first paint, so a page opened afresh shows its panel at once rather than sliding
	// over to it.
	useLayoutEffect(() => {
		setLabel(label);
		setUp(false);
		return () => setLabel(null);
	}, [label, setLabel, setUp]);
	return createPortal(
		// On a phone, a pick in it, as another of Chat's agents, closes the sidebar's sheet, as the
		// navigation's do.
		<div
			className="contents"
			onClickCapture={(event) => {
				if (event.target instanceof Element && event.target.closest('a')) {
					setOpenMobile(false);
				}
			}}
		>
			{children}
		</div>,
		slot,
	);
}

/** In the sidebar: where the page's panel shows. */
export function SidebarPanelHost() {
	const {slot} = useSidebarPanel();
	const host = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		host.current?.append(slot);
	}, [slot]);
	return <div ref={host} className="flex min-h-0 flex-1 flex-col" />;
}

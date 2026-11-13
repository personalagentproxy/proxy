import {type CSSProperties, useRef} from 'react';
import {Outlet} from 'react-router';
import {SidebarProvider, useSidebar} from '@proxy/ui/components/sidebar';
import {CommandPaletteProvider} from '@/components/command-palette';
import {AppSidebar} from '@/components/nav';
import {ResizeHandle} from '@/components/resize-handle';
import {SidebarPanelProvider} from '@/components/sidebar-panel';
import {TitleBarStart} from '@/components/title-bar';
import {UnreadProvider} from '@/components/unread-provider';
import {useOrgSlug} from '@/hooks/use-org';
import {useSidebarFolded} from '@/hooks/use-sidebar-folded';
import {useStoredWidth} from '@/hooks/use-stored-width';

// How narrow and how wide the person may drag the navigation, in pixels; it never takes more than
// a share of the window, however wide they left it on a wider one.
const SIDEBAR_MIN = 192;
const SIDEBAR_MAX = 480;
const SIDEBAR_SHARE = 0.4;

function sidebarWidth(width: number): string {
	return `min(${width}px, ${SIDEBAR_SHARE * 100}vw)`;
}

// The human side, behind its sign-in (the route's loader). The navigation is the same one on every
// page, out on desktop until the person folds it away from the title bar's start, and kept so.
// Keyed by the organization, so a page switched to another's starts over, rather than keeping what
// was typed, picked or open in the one before; what is unread in the conversations of the
// sidebar's organization, the one the account page was opened from there, is kept around every
// page, and so is the command bar that Cmd+K opens over any of them. The navigation is as wide as
// the person dragged its edge, on this device.
export function HumanSide() {
	const org = useOrgSlug();
	const {folded, setFolded} = useSidebarFolded();
	const {width, setWidth} = useStoredWidth('proxy-sidebar-width');
	const wrapper = useRef<HTMLDivElement>(null);
	return (
		<SidebarProvider
			ref={wrapper}
			collapsed={folded}
			onCollapsedChange={setFolded}
			style={
				width === null ? undefined : ({'--sidebar-width': sidebarWidth(width)} as CSSProperties)
			}
		>
			<UnreadProvider key={org}>
				<CommandPaletteProvider>
					<SidebarPanelProvider>
						<AppSidebar />
						<SidebarResizeHandle
							measure={() =>
								wrapper.current
									?.querySelector('[data-slot="sidebar-container"]')
									?.getBoundingClientRect().width ?? SIDEBAR_MIN
							}
							apply={(next) =>
								wrapper.current?.style.setProperty('--sidebar-width', sidebarWidth(next))
							}
							commit={setWidth}
						/>
						<Outlet key={org} />
						{/* After the page: the desktop app takes the window's drag surface from the page
						    in order, the later over the earlier, and with the navigation folded away the
						    page's header, which drags the window, reaches under the toggle. */}
						<TitleBarStart />
					</SidebarPanelProvider>
				</CommandPaletteProvider>
			</UnreadProvider>
		</SidebarProvider>
	);
}

// The navigation's edge, down from the title bar along its divider (index.css), while it is out on
// desktop.
function SidebarResizeHandle({
	measure,
	apply,
	commit,
}: {
	measure: () => number;
	apply: (width: number) => void;
	commit: (width: number | null) => void;
}) {
	const {state, isMobile} = useSidebar();
	if (isMobile || state === 'collapsed') {
		return null;
	}
	return (
		<ResizeHandle
			label="Resize sidebar"
			grows="right"
			measure={measure}
			bounds={() => ({
				min: SIDEBAR_MIN,
				max: Math.min(SIDEBAR_MAX, window.innerWidth * SIDEBAR_SHARE),
			})}
			apply={apply}
			commit={commit}
			className="fixed top-(--title-bar-height) bottom-0 left-(--sidebar-width) z-20 -translate-x-1/2"
		/>
	);
}

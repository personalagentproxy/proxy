import {useState} from 'react';
import {Outlet} from 'react-router';
import {DesktopHistory} from '@/components/desktop-history';
import {ReleaseNotice} from '@/components/release-notice';
import {TitleBarSlot} from '@/hooks/use-title-bar-slot';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';

// Around every page, the human side's and the agents' alike: the page, word of a new release, and
// in the desktop app's title bar, back and forward, followed by the page's controls and title.
export function Root() {
	const [controls, setControls] = useState<HTMLElement | null>(null);
	const [title, setTitle] = useState<HTMLElement | null>(null);
	return (
		<TitleBarSlot value={{controls, title}}>
			<Outlet />
			<ReleaseNotice />
			{hasHiddenDesktopTitleBar() && (
				<DesktopHistory controlsRef={setControls} titleRef={setTitle} />
			)}
		</TitleBarSlot>
	);
}

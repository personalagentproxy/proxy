import {useState} from 'react';
import {Outlet} from 'react-router';
import {DesktopHistory} from '@/components/desktop-history';
import {DesktopUpdateNotice} from '@/components/desktop-update-notice';
import {TitleBarSlot} from '@/hooks/use-title-bar-slot';
import {useReloadOnRelease} from '@/hooks/use-reload-on-release';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';

// Around every page, the human side's and the agents' alike: the page, kept on the newest release
// of the web app, word of the desktop app's update, and in the desktop app's title bar, back and
// forward, followed by the page's controls and title.
export function Root() {
	useReloadOnRelease();
	const [controls, setControls] = useState<HTMLElement | null>(null);
	const [title, setTitle] = useState<HTMLElement | null>(null);
	return (
		<TitleBarSlot value={{controls, title}}>
			<Outlet />
			<DesktopUpdateNotice />
			{hasHiddenDesktopTitleBar() && (
				<DesktopHistory controlsRef={setControls} titleRef={setTitle} />
			)}
		</TitleBarSlot>
	);
}

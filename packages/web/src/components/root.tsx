import {Outlet} from 'react-router';
import {DesktopHistoryKeys} from '@/components/history';
import {DesktopUpdateNotice} from '@/components/desktop-update-notice';
import {useReloadOnRelease} from '@/hooks/use-reload-on-release';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';

// Around every page, the human side's and the agents' alike: the page, kept on the newest release
// of the web app, word of the desktop app's update, and in the desktop app, back and forward on
// the keys and mouse buttons a browser has for them.
export function Root() {
	useReloadOnRelease();
	return (
		<>
			<Outlet />
			<DesktopUpdateNotice />
			{hasHiddenDesktopTitleBar() && <DesktopHistoryKeys />}
		</>
	);
}

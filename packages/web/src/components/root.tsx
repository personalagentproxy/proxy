import {Outlet} from 'react-router';
import {DesktopHistory} from '@/components/desktop-history';
import {ReleaseNotice} from '@/components/release-notice';
import {hasHiddenDesktopTitleBar} from '@/lib/desktop';

// Around every page, the human side's and the agents' alike: the page, word of a new release, and
// in the desktop app's title bar, back and forward.
export function Root() {
	return (
		<>
			<Outlet />
			<ReleaseNotice />
			{hasHiddenDesktopTitleBar() && <DesktopHistory />}
		</>
	);
}

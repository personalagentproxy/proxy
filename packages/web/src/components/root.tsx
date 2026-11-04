import {Outlet} from 'react-router';
import {ReleaseNotice} from '@/components/release-notice';

// Around every page, the human side's and the agents' alike: the page, and word of a new release.
export function Root() {
	return (
		<>
			<Outlet />
			<ReleaseNotice />
		</>
	);
}

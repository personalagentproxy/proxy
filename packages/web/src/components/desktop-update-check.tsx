import {Button} from '@proxy/ui/components/button';
import {useDesktopUpdateStatus} from '@/hooks/use-desktop-update-status';
import {desktopBridge, type DesktopUpdateStatus} from '@/lib/desktop';

// In the desktop app, the way to its next version: Check for updates looks now rather than at the
// app's next look, and says where that stands, through the download, until Restart installs it.
// An app from before the check can't be asked to look; it is told how to have it look itself, by
// opening it again, and offered the restart once it has downloaded one. Nothing in a browser.
export function DesktopUpdateCheck() {
	const update = useDesktopUpdateStatus();
	if (!update) {
		return null;
	}

	const {status, check} = update;
	if (status.state === 'ready') {
		return (
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<Button type="button" size="sm" onClick={() => desktopBridge()?.restart()}>
					Restart to update
				</Button>
				<span className="text-muted-foreground">Version {status.version} is downloaded.</span>
			</div>
		);
	}

	if (!check) {
		return (
			<p className="text-sm text-muted-foreground">
				Quit and reopen the app to update it. It looks for a new version as it starts.
			</p>
		);
	}

	if (status.state === 'unavailable') {
		return <p className="text-sm text-muted-foreground">This build doesn't update itself.</p>;
	}

	const busy = status.state === 'checking' || status.state === 'downloading';
	return (
		<div className="flex flex-wrap items-center gap-3 text-sm">
			<Button type="button" size="sm" variant="outline" disabled={busy} onClick={check}>
				Check for updates
			</Button>
			<span
				role="status"
				className={status.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}
			>
				{describe(status)}
			</span>
		</div>
	);
}

// What the check found, in words; nothing before it has looked.
function describe(status: DesktopUpdateStatus): string {
	if (status.state === 'checking') {
		return 'Checking for updates…';
	}

	if (status.state === 'downloading') {
		return `Downloading version ${status.version}… ${Math.floor(status.percent)}%`;
	}

	if (status.state === 'latest') {
		return 'You have the latest version.';
	}

	if (status.state === 'failed') {
		return 'Could not check for updates. Try again.';
	}

	return '';
}

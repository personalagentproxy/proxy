import {XIcon} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {useLocation} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {useDesktopUpdate} from '@/hooks/use-desktop-update';
import {useNewRelease} from '@/hooks/use-new-release';
import {desktopBridge} from '@/lib/desktop';

function reloadPage(): void {
	window.location.reload();
}

function restartDesktop(): void {
	desktopBridge()?.restart();
}

// What the button does: restart the desktop app, or reload the page.
type Action = 'restart' | 'reload';

function Notice({
	action,
	onAction,
	onDismiss,
}: {
	action: string;
	onAction: () => void;
	onDismiss: () => void;
}) {
	return (
		<div
			role="status"
			className="fixed right-4 bottom-4 z-50 flex flex-col items-start gap-3 rounded-lg border bg-background p-4 pr-12 text-sm shadow-lg"
		>
			<span>A new version of Personal Agent Proxy is ready.</span>
			<Button size="sm" onClick={onAction}>
				{action}
			</Button>
			<Button
				variant="ghost"
				size="icon-xs"
				className="absolute top-2 right-2"
				aria-label="Dismiss"
				onClick={onDismiss}
			>
				<XIcon />
			</Button>
		</div>
	);
}

// A new version, once there is one: a notice in the corner with a button. In the desktop app
// with an update downloaded, the button restarts the app into it. Otherwise, with a new release
// of the web app on the server, the button reloads the page, and, left alone, the next move to
// another page reloads instead, which the new release then shows, so nothing in the middle of
// being typed is lost to it. Dismissed, the notice goes and nothing else changes: the page still
// reloads at the next move, and the app still updates when it next quits.
export function ReleaseNotice({reload = reloadPage}: {reload?: () => void}) {
	const update = useDesktopUpdate();
	const newRelease = useNewRelease();
	const {pathname} = useLocation();
	const pathAtNotice = useRef<string | null>(null);
	const [dismissed, setDismissed] = useState<Action | null>(null);

	useEffect(() => {
		if (!newRelease) {
			return;
		}
		if (pathAtNotice.current === null) {
			pathAtNotice.current = pathname;
			return;
		}
		if (pathname !== pathAtNotice.current) {
			reload();
		}
	}, [newRelease, pathname, reload]);

	const action: Action | null = update ? 'restart' : newRelease ? 'reload' : null;
	if (!action || dismissed === action) {
		return null;
	}

	if (action === 'restart') {
		return (
			<Notice
				action="Restart"
				onAction={restartDesktop}
				onDismiss={() => setDismissed('restart')}
			/>
		);
	}

	return <Notice action="Reload" onAction={reload} onDismiss={() => setDismissed('reload')} />;
}

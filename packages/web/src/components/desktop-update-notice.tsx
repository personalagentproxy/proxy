import {XIcon} from 'lucide-react';
import {useState} from 'react';
import {Button} from '@proxy/ui/components/button';
import {useDesktopUpdate} from '@/hooks/use-desktop-update';
import {desktopBridge} from '@/lib/desktop';

// The update dismissed in this window, kept across the reloads new releases of the web app bring.
const DISMISSED_KEY = 'proxy:dismissed-desktop-update';

function restartDesktop(): void {
	desktopBridge()?.restart();
}

// In the desktop app with an update downloaded, a notice in the corner whose button restarts the
// app into it. A new release of the web app needs none: the page reloads into it by itself
// (`useReloadOnRelease`). Dismissed, the notice goes, for that update, and the app still updates
// when it next quits.
export function DesktopUpdateNotice() {
	const update = useDesktopUpdate();
	const [dismissed, setDismissed] = useState(() => window.sessionStorage.getItem(DISMISSED_KEY));

	if (!update || dismissed === update) {
		return null;
	}

	const dismiss = () => {
		window.sessionStorage.setItem(DISMISSED_KEY, update);
		setDismissed(update);
	};

	return (
		<div
			role="status"
			className="fixed right-4 bottom-4 z-50 flex flex-col items-start gap-3 rounded-lg border bg-background p-4 pr-12 text-sm shadow-lg"
		>
			<span>A new version of Personal Agent Proxy is ready.</span>
			<Button size="sm" onClick={restartDesktop}>
				Restart
			</Button>
			<Button
				variant="ghost"
				size="icon-xs"
				className="absolute top-2 right-2"
				aria-label="Dismiss"
				onClick={dismiss}
			>
				<XIcon />
			</Button>
		</div>
	);
}

import {useEffect, useState} from 'react';
import {desktopBridge} from '@/lib/desktop';

// The version of the desktop app's downloaded update, once it has one; null in a browser, and in
// the app until then. Asked on mount, for a page loaded after the download, and told after.
export function useDesktopUpdate(): string | null {
	const [version, setVersion] = useState<string | null>(null);

	useEffect(() => {
		const bridge = desktopBridge();
		if (!bridge) {
			return;
		}

		let cancelled = false;
		void bridge.updateReady().then(
			(ready) => {
				if (!cancelled && ready) {
					setVersion(ready);
				}
			},
			() => undefined,
		);
		const stop = bridge.onUpdateReady(setVersion);

		return () => {
			cancelled = true;
			stop();
		};
	}, []);

	return version;
}

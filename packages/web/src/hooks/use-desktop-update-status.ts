import {useEffect, useState} from 'react';
import {desktopBridge, type DesktopUpdateStatus} from '@/lib/desktop';

/**
 * Where the desktop app's update stands, as it changes, and the look for one begun now, where the
 * app can be asked to; null in a browser. An app from before the update check tells only of an
 * update downloaded, and has no `check`: it looks on start and every few hours by itself.
 */
export function useDesktopUpdateStatus(): {
	status: DesktopUpdateStatus;
	check: (() => void) | null;
} | null {
	const bridge = desktopBridge();
	const [status, setStatus] = useState<DesktopUpdateStatus>({state: 'idle'});

	useEffect(() => {
		if (!bridge) {
			return;
		}

		let cancelled = false;
		if (bridge.updateStatus && bridge.onUpdateStatus) {
			void bridge.updateStatus().then(
				(current) => {
					if (!cancelled && current) {
						setStatus(current);
					}
				},
				() => undefined,
			);
			const stop = bridge.onUpdateStatus(setStatus);
			return () => {
				cancelled = true;
				stop();
			};
		}

		const ready = (version: string) => setStatus({state: 'ready', version});
		void bridge.updateReady().then(
			(version) => {
				if (!cancelled && version) {
					ready(version);
				}
			},
			() => undefined,
		);
		const stop = bridge.onUpdateReady(ready);
		return () => {
			cancelled = true;
			stop();
		};
	}, [bridge]);

	if (!bridge) {
		return null;
	}

	if (!bridge.checkForUpdates) {
		return {status, check: null};
	}
	return {status, check: () => bridge.checkForUpdates?.()};
}

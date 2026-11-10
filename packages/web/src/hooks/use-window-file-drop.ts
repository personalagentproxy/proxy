import {useEffect, useState} from 'react';

/**
 * Files dropped anywhere on the window, while `enabled`: the whole window is where they land, so
 * the person needn't aim at an input. Says whether files are being dragged over it now, for the
 * page to show where they will go; a drag of anything else, as of text, is left alone. `onFiles`
 * is given what was dropped.
 */
export function useWindowFileDrop(enabled: boolean, onFiles: (files: File[]) => void): boolean {
	const [over, setOver] = useState(false);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		// A drag enters and leaves each element it crosses: over the window while it has entered
		// more than it has left.
		let depth = 0;
		const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
		const onEnter = (event: DragEvent) => {
			if (!carriesFiles(event)) {
				return;
			}
			depth += 1;
			setOver(true);
		};
		const onOver = (event: DragEvent) => {
			if (carriesFiles(event)) {
				event.preventDefault();
			}
		};
		const onLeave = (event: DragEvent) => {
			if (!carriesFiles(event)) {
				return;
			}
			depth = Math.max(0, depth - 1);
			if (depth === 0) {
				setOver(false);
			}
		};
		const onDrop = (event: DragEvent) => {
			if (!carriesFiles(event)) {
				return;
			}
			event.preventDefault();
			depth = 0;
			setOver(false);
			const dropped = [...(event.dataTransfer?.files ?? [])];
			if (dropped.length > 0) {
				onFiles(dropped);
			}
		};
		window.addEventListener('dragenter', onEnter);
		window.addEventListener('dragover', onOver);
		window.addEventListener('dragleave', onLeave);
		window.addEventListener('drop', onDrop);
		return () => {
			window.removeEventListener('dragenter', onEnter);
			window.removeEventListener('dragover', onOver);
			window.removeEventListener('dragleave', onLeave);
			window.removeEventListener('drop', onDrop);
			setOver(false);
		};
	}, [enabled, onFiles]);

	return over;
}

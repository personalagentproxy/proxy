import {useRef, useState} from 'react';

// Changes not yet saved and loaded back, to a connection's defaults and to an agent's own settings.
type Pending = {
	defaults: Partial<Record<string, boolean>>;
	own: Record<string, boolean | null>;
};

export type AccessSaves = {
	pending: Pending;
	save: (changes: Pending, run: () => Promise<void>) => void;
};

const NOTHING_PENDING: Pending = {defaults: {}, own: {}};

// The access changes a page is saving, by connection, shown over the page's data until every one
// is saved and loaded back, and saved one after another in the order they were made. Kept by the
// page rather than each connection's checkboxes, so a change outlives its connection being folded
// or filtered away while it is saved.
export function useAccessSaves(): (connectionId: string) => AccessSaves {
	const [pending, setPending] = useState<Partial<Record<string, Pending>>>({});
	const saving = useRef({queue: Promise.resolve(), count: 0});
	return (connectionId) => ({
		pending: pending[connectionId] ?? NOTHING_PENDING,
		save: (changes, run) => {
			setPending((current) => {
				const was = current[connectionId] ?? NOTHING_PENDING;
				return {
					...current,
					[connectionId]: {
						defaults: {...was.defaults, ...changes.defaults},
						own: {...was.own, ...changes.own},
					},
				};
			});
			saving.current.count += 1;
			saving.current.queue = saving.current.queue.then(async () => {
				await run();
				saving.current.count -= 1;
				if (saving.current.count === 0) {
					setPending({});
				}
			});
		},
	});
}

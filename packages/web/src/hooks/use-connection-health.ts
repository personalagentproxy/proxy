import {useRef, useState} from 'react';
import type {ConnectionHealth} from '@proxy/contracts/connections';

import {checkConnectionHealth} from '@/client/connections-client';
import {describeFetchError} from '@/lib/loader-utils';

/** On demand only. Results describe this check, not continuous monitoring. */
export function useConnectionHealth(org: string) {
	const [results, setResults] = useState<Record<string, ConnectionHealth>>({});
	const [checking, setChecking] = useState<Set<string>>(new Set());
	const active = useRef(new Set<string>());

	const check = async (id: string) => {
		if (active.current.has(id)) {
			return;
		}
		active.current.add(id);
		setChecking(new Set(active.current));
		try {
			const result = await checkConnectionHealth(org, id);
			const health: ConnectionHealth = result.isOk()
				? result.value
				: {
						status: 'error',
						checkedAt: new Date().toISOString(),
						message: describeFetchError(result.error),
					};
			setResults((current) => ({...current, [id]: health}));
		} finally {
			active.current.delete(id);
			setChecking(new Set(active.current));
		}
	};

	const checkMany = async (ids: string[]) => {
		if (active.current.size > 0) {
			return;
		}
		// Avoid flooding providers or starting a request for every row at once.
		const queue = [...new Set(ids)];
		await Promise.all(
			Array.from({length: Math.min(3, queue.length)}, async () => {
				let id = queue.shift();
				while (id !== undefined) {
					await check(id);
					id = queue.shift();
				}
			}),
		);
	};

	return {results, checking, check, checkMany};
}

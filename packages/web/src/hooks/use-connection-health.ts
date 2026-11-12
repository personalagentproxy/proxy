import {useCallback, useRef, useState} from 'react';
import type {ConnectionHealth} from '@proxy/contracts/connections';

import {checkConnectionHealth} from '@/client/connections-client';
import {describeFetchError} from '@/lib/loader-utils';

/** Reuse a saved result for 15 minutes before checking the provider again. */
export const CONNECTION_HEALTH_MAX_AGE_MS = 15 * 60 * 1000;

export function connectionHealthIsStale(health?: ConnectionHealth, now = Date.now()): boolean {
	if (!health) {
		return true;
	}
	const checkedAt = Date.parse(health.checkedAt);
	return !Number.isFinite(checkedAt) || now - checkedAt >= CONNECTION_HEALTH_MAX_AGE_MS;
}

/** Results describe the last safe provider probe; they do not represent continuous monitoring. */
export function useConnectionHealth(
	org: string,
	initialResults: Record<string, ConnectionHealth> = {},
) {
	const [results, setResults] = useState<Record<string, ConnectionHealth>>(() => initialResults);
	const [checking, setChecking] = useState<Set<string>>(new Set());
	const active = useRef(new Set<string>());

	const check = useCallback(
		async (id: string) => {
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
		},
		[org],
	);

	const checkMany = useCallback(
		async (ids: string[]) => {
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
		},
		[check],
	);

	return {results, checking, check, checkMany};
}

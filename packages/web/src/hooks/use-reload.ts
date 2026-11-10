import {useCallback} from 'react';
import {useRevalidator} from 'react-router';
import {loadsOnTheWay} from '@/lib/loader-utils';

/**
 * Loads the page's data again, as after a change: resolves once the new answer has come, that of a
 * loader answering `later` included, so what follows finds the page up to date.
 */
export function useReload(): () => Promise<void> {
	const {revalidate} = useRevalidator();
	return useCallback(async () => {
		const before = loadsOnTheWay();
		await revalidate();
		await Promise.allSettled([...loadsOnTheWay()].filter((load) => !before.has(load)));
	}, [revalidate]);
}

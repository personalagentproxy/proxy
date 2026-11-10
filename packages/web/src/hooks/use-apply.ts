import type {FetchError} from '@proxy/utils';
import type {Result} from 'ts-results-es';
import {useReload} from '@/hooks/use-reload';
import {describeApiError} from '@/lib/loader-utils';

/**
 * Saves a change from a page and loads the page's data again once it is saved, after `onSaved`,
 * such as closing a dialog. What went wrong goes to `setError`, and null once a change is saved.
 */
export function useApply(setError: (error: string | null) => void) {
	const reload = useReload();
	return async <T>(change: Promise<Result<T, FetchError>>, onSaved?: () => void) => {
		const result = await change;
		if (result.isErr()) {
			setError(describeApiError(result.error));
			return;
		}
		setError(null);
		onSaved?.();
		await reload();
	};
}

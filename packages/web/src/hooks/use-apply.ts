import type {FetchError} from '@proxy/utils';
import {useRevalidator} from 'react-router';
import type {Result} from 'ts-results-es';
import {describeApiError} from '@/lib/loader-utils';

/**
 * Saves a change from a page and loads the page's data again once it is saved, after `onSaved`,
 * such as closing a dialog. What went wrong goes to `setError`, and null once a change is saved.
 */
export function useApply(setError: (error: string | null) => void) {
	const revalidator = useRevalidator();
	return async <T>(change: Promise<Result<T, FetchError>>, onSaved?: () => void) => {
		const result = await change;
		if (result.isErr()) {
			setError(describeApiError(result.error));
			return;
		}
		setError(null);
		onSaved?.();
		await revalidator.revalidate();
	};
}

import type {ApiError} from '@proxy/utils';

/**
 * Whether what failed for one item of a data migration might go through on the next start: the
 * provider or the database out of reach, or the api told to wait. The migration is then left
 * unnoted, to be tried again (`run.ts`). Any other failure is the item's for good, as a credential
 * that can't be read: it is logged and passed over, so one such item doesn't hold the migration
 * open, tried again and failing on every start of every instance.
 */
export function worthRetrying(error: ApiError): boolean {
	return error.kind === 'provider_unreachable' || error.kind === 'db_error' || error.kind === 'unavailable';
}

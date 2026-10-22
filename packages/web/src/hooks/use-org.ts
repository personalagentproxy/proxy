import {useParams} from 'react-router';

/**
 * The slug of the organization the address names (`/:org/…`), on every page in one, the welcome
 * flow included: where its api calls go and its links lead. Empty outside one.
 */
export function useOrgSlug(): string {
	return useParams<{org: string}>().org ?? '';
}

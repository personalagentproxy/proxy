import {useParams} from 'react-router';
import {useHuman} from '@/hooks/use-human';

/**
 * The slug of the organization the person is in: the one the address names (`/:org/…`), on every
 * page in one, the welcome flow included, or on their account page, which names none, the one it
 * was opened from (the human side's loader). Where its api calls go and its links lead. Empty
 * outside both.
 */
export function useOrgSlug(): string {
	const addressed = useParams<{org: string}>().org;
	const human = useHuman();
	return addressed ?? human?.org.slug ?? '';
}

import {useRouteLoaderData} from 'react-router';
import type {Human} from '@/lib/orgs';

/** Who is signed in on the human side and their organizations; null outside it. */
export function useHuman(): Human | null {
	return useRouteLoaderData<Human>('human') ?? null;
}

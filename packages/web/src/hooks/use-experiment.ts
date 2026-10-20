import type {Experiment} from '@proxy/utils';
import {useRouteLoaderData} from 'react-router';
import type {Me} from '@/client/me-client';

// Every experiment on for the signed-in person's organization, from the human side's loader; none
// outside it, as in the welcome flow. Hiding something here is only for looks: the api checks the
// experiment itself.
export function useExperiments(): Experiment[] {
	return useRouteLoaderData<Me>('human')?.experiments ?? [];
}

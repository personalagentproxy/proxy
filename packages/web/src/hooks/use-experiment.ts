import {hasExperiment, type Experiment} from '@proxy/utils';
import {useRouteLoaderData} from 'react-router';
import type {Me} from '@/client/me-client';

// Whether the experiment is on for the signed-in person's organization, from the human side's
// loader; off outside it, as in the welcome flow. Hiding something here is only for looks: the
// api checks the experiment itself.
export function useExperiment(experiment: Experiment): boolean {
	const me = useRouteLoaderData<Me>('human');
	return me ? hasExperiment(me, experiment) : false;
}

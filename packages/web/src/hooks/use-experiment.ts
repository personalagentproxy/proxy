import type {Experiment} from '@proxy/utils';
import {useHuman} from '@/hooks/use-human';

// Every experiment on for the organization the address names, from the human side's loader; none
// outside it, as in the welcome flow, which loads them itself. Hiding something here is only for
// looks: the api checks the experiment itself.
export function useExperiments(): Experiment[] {
	return useHuman()?.org.experiments ?? [];
}

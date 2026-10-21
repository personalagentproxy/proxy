/**
 * Features being tried out, each turned on for some organizations before everyone gets it, from
 * the internal admin (`Organization.experiments`, or all of them for an insider organization). The
 * key is the id kept in the database, the value what the admin calls it. When an experiment ships
 * or is dropped, delete it here, and the compiler points at every place that asked for it; its id
 * left in the database is ignored.
 */
export const EXPERIMENTS = {
	// The Ask quick action: what a meeting, document, email or issue says, answered from reading it.
	ask: 'Ask quick action',
} as const satisfies Record<string, string>;

export type Experiment = keyof typeof EXPERIMENTS;

export function isExperiment(id: string): id is Experiment {
	return Object.hasOwn(EXPERIMENTS, id);
}

/** What is on for an organization: every experiment for an insider, else its own that still exist. */
export function organizationExperiments(organization: {
	insider: boolean;
	experiments: string[];
}): Experiment[] {
	if (organization.insider) {
		return Object.keys(EXPERIMENTS).filter(isExperiment);
	}
	return organization.experiments.filter(isExperiment);
}

/** Whether a signed-in person or agent (`request.user`, `SignedInAgent`, the web app's `Me`) has the experiment on. */
export function hasExperiment(
	holder: {experiments: Experiment[]},
	experiment: Experiment,
): boolean {
	return holder.experiments.includes(experiment);
}

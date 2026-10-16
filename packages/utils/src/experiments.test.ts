import {describe, expect, it} from 'bun:test';

import {EXPERIMENTS, isExperiment, organizationExperiments} from './experiments';

describe('organizationExperiments', () => {
	it('drops ids that are no longer experiments', () => {
		expect(organizationExperiments({insider: false, experiments: ['shipped-long-ago']})).toEqual(
			[],
		);
	});

	it('turns every experiment on for an insider, whatever it has of its own', () => {
		expect(organizationExperiments({insider: true, experiments: ['shipped-long-ago']})).toEqual(
			Object.keys(EXPERIMENTS).filter(isExperiment),
		);
	});
});

describe('isExperiment', () => {
	it('does not take what every object has', () => {
		expect(isExperiment('toString')).toBe(false);
		expect(isExperiment('constructor')).toBe(false);
	});
});

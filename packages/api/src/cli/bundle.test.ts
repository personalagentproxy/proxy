import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

const buildPap = mock();

mock.module('@proxy/cli/build', () => ({buildPap}));

const error = mock();

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error},
	serializeError: (cause: Error) => ({message: cause.message}),
}));

beforeEach(() => {
	mock.clearAllMocks();
});

describe('papBundle', () => {
	test('a build that fails is unavailable and logged, and tried again; one that works is kept', async () => {
		const {papBundle} = await import('./bundle');
		buildPap.mockResolvedValueOnce(Err(new Error('Could not resolve "./run"')));
		buildPap.mockResolvedValueOnce(Ok({code: 'pap', version: 'v1'}));

		const failed = await papBundle();
		const first = await papBundle();
		const second = await papBundle();

		expect(failed.unwrapErr()).toMatchObject({kind: 'unavailable', message: expect.stringContaining('could not build it')});
		expect(error).toHaveBeenCalledWith('Building the pap CLI failed', {message: 'Could not resolve "./run"'});
		expect(first.unwrap()).toEqual({code: 'pap', version: 'v1'});
		expect(second.unwrap()).toEqual({code: 'pap', version: 'v1'});
		expect(buildPap).toHaveBeenCalledTimes(2);
	});
});

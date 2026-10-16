/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, renderHook, waitFor} from '@testing-library/react';
import type {FetchError} from '@proxy/utils';
import {Ok, type Result} from 'ts-results-es';
import {lookup} from '@/lib/lookup';

afterEach(() => {
	cleanup();
});

// A store answering how many times it has been read, so a second read shows.
function counting() {
	let reads = 0;
	return lookup((_day: string): Promise<Result<number, FetchError>> => {
		reads += 1;
		return Promise.resolve(Ok(reads));
	});
}

describe('lookup', () => {
	test('reads the same again once cleared, while it is still shown', async () => {
		const useCount = counting();
		const {result} = renderHook(() => useCount('2026-10-16'));
		await waitFor(() => expect(result.current).toEqual({data: 1, error: null, loading: false}));

		act(() => useCount.clear());

		await waitFor(() => expect(result.current).toEqual({data: 2, error: null, loading: false}));
	});

	test('keeps no answer asked for before a clear', async () => {
		let answer: (value: Result<number, FetchError>) => void = () => {};
		let reads = 0;
		const useSlow = lookup((_day: string) => {
			reads += 1;
			return new Promise<Result<number, FetchError>>((resolve) => {
				answer = resolve;
			});
		});
		const {result} = renderHook(() => useSlow('2026-10-16'));
		await waitFor(() => expect(reads).toBe(1));
		const before = answer;

		act(() => useSlow.clear());
		await waitFor(() => expect(reads).toBe(2));
		await act(async () => {
			before(Ok(1));
			answer(Ok(2));
		});

		await waitFor(() => expect(result.current).toEqual({data: 2, error: null, loading: false}));
	});
});

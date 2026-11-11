/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import {cleanup, render, waitFor} from '@testing-library/react';
import {useListMotion} from '@/hooks/use-list-motion';

// Where a row is laid out: the test's dom lays nothing out, so each row is told.
type Place = {top: number; height: number};

function place({top, height}: Place) {
	return (row: HTMLLIElement | null) => {
		if (row === null) {
			return;
		}
		Object.defineProperties(row, {
			offsetTop: {value: top, configurable: true},
			offsetHeight: {value: height, configurable: true},
		});
	};
}

// A list of rows, each `[its key, where it is laid out]`, in the order drawn.
function Rows({rows}: {rows: Array<[string, Place]>}) {
	const list = useListMotion<HTMLUListElement>();
	return (
		<ul ref={list}>
			{rows.map(([key, at]) => (
				<li key={key} data-row={key} ref={place(at)}>
					<span>{key}</span>
				</li>
			))}
		</ul>
	);
}

// What was animated, by the text of the element: its keyframes as the hook gave them.
let moved: Array<{of: string; frames: Keyframe[]}> = [];
const animate = Element.prototype.animate;
let spy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
	moved = [];
	spy = spyOn(Element.prototype, 'animate').mockImplementation(function (
		this: Element,
		frames: Keyframe[] | PropertyIndexedKeyframes | null,
		options?: number | KeyframeAnimationOptions,
	) {
		moved.push({of: this.textContent ?? '', frames: Array.isArray(frames) ? frames : []});
		return animate.call(this, frames, options);
	});
});

afterEach(() => {
	cleanup();
	spy?.mockRestore();
	Reflect.deleteProperty(globalThis, 'matchMedia');
});

const agent = {top: 0, height: 56};

describe('useListMotion', () => {
	test('moves nothing as the list first shows, or as it is drawn again with its rows in place', () => {
		const rows: Array<[string, Place]> = [
			['a', agent],
			['b', {top: 58, height: 56}],
		];
		const {rerender} = render(<Rows rows={rows} />);
		rerender(<Rows rows={[...rows]} />);

		expect(moved).toEqual([]);
	});

	test('uncovers a row that comes, from its top, as the rows after it slide down from where they were', () => {
		const {rerender} = render(
			<Rows
				rows={[
					['a', agent],
					['b', {top: 58, height: 56}],
				]}
			/>,
		);
		rerender(
			<Rows
				rows={[
					['a', agent],
					['task', {top: 56, height: 34}],
					['b', {top: 92, height: 56}],
				]}
			/>,
		);

		expect(moved).toEqual([
			{of: 'b', frames: [{transform: 'translateY(-34px)'}, {transform: 'translateY(0)'}]},
			// The row comes down over its content, which moves up within it by as much.
			{of: 'task', frames: [{transform: 'translateY(-34px)'}, {transform: 'translateY(0)'}]},
			{
				of: 'task',
				frames: [
					{transform: 'translateY(34px)', opacity: 0},
					{transform: 'translateY(0)', opacity: 1},
				],
			},
		]);
	});

	test('keeps a row that goes where it was, out of reach, until the rows after it have slid up over it', async () => {
		const {rerender, container} = render(
			<Rows
				rows={[
					['a', agent],
					['task', {top: 56, height: 34}],
					['b', {top: 92, height: 56}],
				]}
			/>,
		);
		const gone = container.querySelector('[data-row="task"]') as HTMLElement;
		rerender(
			<Rows
				rows={[
					['a', agent],
					['b', {top: 58, height: 56}],
				]}
			/>,
		);

		expect(gone.parentElement).toBe(container.querySelector('ul'));
		expect(gone.inert).toBe(true);
		expect(gone.getAttribute('aria-hidden')).toBe('true');
		// No longer one of the list's rows, so drawing the list again leaves it be.
		expect(gone.hasAttribute('data-row')).toBe(false);
		expect(gone.style.position).toBe('absolute');
		expect(gone.style.top).toBe('56px');
		expect(moved).toEqual([
			{of: 'b', frames: [{transform: 'translateY(34px)'}, {transform: 'translateY(0)'}]},
			{of: 'task', frames: [{transform: 'translateY(0)'}, {transform: 'translateY(-34px)'}]},
			{
				of: 'task',
				frames: [
					{transform: 'translateY(0)', opacity: 1},
					{transform: 'translateY(34px)', opacity: 0},
				],
			},
		]);

		await waitFor(() => expect(gone.isConnected).toBe(false));
	});

	test('fades a row in over the one whose place it takes, the rows around them staying put', async () => {
		const {rerender, container} = render(
			<Rows
				rows={[
					['a', agent],
					['one', {top: 56, height: 34}],
					['b', {top: 92, height: 56}],
				]}
			/>,
		);
		const gone = container.querySelector('[data-row="one"]') as HTMLElement;
		rerender(
			<Rows
				rows={[
					['a', agent],
					['other', {top: 56, height: 34}],
					['b', {top: 92, height: 56}],
				]}
			/>,
		);

		expect(moved).toEqual([
			{of: 'other', frames: [{opacity: 0}, {opacity: 1}]},
			{of: 'one', frames: [{opacity: 1}, {opacity: 0}]},
		]);
		await waitFor(() => expect(gone.isConnected).toBe(false));
	});

	test('slides rows that change places to their new ones', () => {
		const {rerender} = render(
			<Rows
				rows={[
					['a', agent],
					['b', {top: 58, height: 56}],
				]}
			/>,
		);
		rerender(
			<Rows
				rows={[
					['b', agent],
					['a', {top: 58, height: 56}],
				]}
			/>,
		);

		expect(moved).toEqual([
			{of: 'b', frames: [{transform: 'translateY(58px)'}, {transform: 'translateY(0)'}]},
			{of: 'a', frames: [{transform: 'translateY(-58px)'}, {transform: 'translateY(0)'}]},
		]);
	});

	test('moves nothing, and keeps no row that went, where the person asked for less motion', () => {
		Object.assign(globalThis, {matchMedia: () => ({matches: true})});
		const {rerender, container} = render(
			<Rows
				rows={[
					['a', agent],
					['task', {top: 56, height: 34}],
					['b', {top: 92, height: 56}],
				]}
			/>,
		);
		rerender(
			<Rows
				rows={[
					['b', agent],
					['a', {top: 58, height: 56}],
				]}
			/>,
		);

		expect(moved).toEqual([]);
		expect(container.querySelectorAll('li')).toHaveLength(2);
	});
});

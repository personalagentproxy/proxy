/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {Action} from '@proxy/integrations';
import type {ComponentProps} from 'react';
import {ConnectionAccess} from '@/components/connection-access';
import {useAccessSaves} from '@/hooks/use-access-saves';

const actions: Action[] = [
	{id: 'read', label: 'Read', description: 'Read emails', risk: 'low'},
	{id: 'send', label: 'Send', description: 'Send emails', risk: 'high'},
];

afterEach(() => {
	cleanup();
});

// A save the test finishes when it wants to, as the api and the page's loader would.
function saves() {
	const calls: {actions: Record<string, boolean | null>; finish: () => void}[] = [];
	const onChange = (changed: Record<string, boolean | null>) =>
		new Promise<void>((resolve) => {
			calls.push({actions: changed, finish: resolve});
		});
	return {calls, onChange};
}

// A page keeping the changes being saved, its connection's checkboxes shown or folded away.
function Page({
	shown = true,
	...props
}: Omit<ComponentProps<typeof ConnectionAccess>, 'saves'> & {shown?: boolean}) {
	const savesFor = useAccessSaves();
	return shown && <ConnectionAccess {...props} saves={savesFor('mailbox')} />;
}

const checked = (name: string) =>
	screen.getByRole('checkbox', {name: new RegExp(name)}).getAttribute('aria-checked');

describe('ConnectionAccess', () => {
	test('ticks a box at once and saves behind it, one save after another', async () => {
		const {calls, onChange} = saves();
		const {rerender} = render(<Page actions={actions} defaults={[]} onChange={onChange} />);

		fireEvent.click(screen.getByRole('checkbox', {name: /Read/}));
		fireEvent.click(screen.getByRole('checkbox', {name: /Send/}));
		expect(checked('Read')).toBe('true');
		expect(checked('Send')).toBe('true');
		await act(async () => {});
		expect(calls.map((call) => call.actions)).toEqual([{read: true}]);

		rerender(<Page actions={actions} defaults={['read']} onChange={onChange} />);
		await act(async () => calls[0]?.finish());
		expect(calls.map((call) => call.actions)).toEqual([{read: true}, {send: true}]);
		expect(checked('Send')).toBe('true');

		rerender(<Page actions={actions} defaults={['read', 'send']} onChange={onChange} />);
		await act(async () => calls[1]?.finish());
		expect(checked('Read')).toBe('true');
		expect(checked('Send')).toBe('true');
	});

	test('shows the page’s data again once every save is done, as when one failed', async () => {
		const {calls, onChange} = saves();
		render(<Page actions={actions} defaults={[]} onChange={onChange} />);

		fireEvent.click(screen.getByRole('checkbox', {name: /Read/}));
		expect(checked('Read')).toBe('true');
		await act(async () => {});
		await act(async () => calls[0]?.finish());
		expect(checked('Read')).toBe('false');
	});

	test('resets an agent’s own setting at once', async () => {
		const {calls, onChange} = saves();
		render(<Page actions={actions} defaults={['read']} own={{read: false}} onChange={onChange} />);

		expect(checked('Read')).toBe('false');
		fireEvent.click(screen.getByRole('button', {name: 'Reset to default'}));
		expect(checked('Read')).toBe('true');
		expect(screen.queryByRole('button', {name: 'Reset to default'})).toBeNull();
		await act(async () => {});
		expect(calls.map((call) => call.actions)).toEqual([{read: null}]);
	});

	test('makes an agent’s own setting the default at once', async () => {
		const {calls, onChange} = saves();
		const made: [string, boolean][] = [];
		render(
			<Page
				actions={actions}
				defaults={[]}
				own={{send: true}}
				onChange={onChange}
				onMakeDefault={async (actionId, allowed) => {
					made.push([actionId, allowed]);
				}}
			/>,
		);

		fireEvent.click(screen.getByRole('button', {name: 'Make this the default for every agent'}));
		expect(checked('Send')).toBe('true');
		expect(screen.queryByRole('button', {name: 'Reset to default'})).toBeNull();
		await act(async () => {});
		expect(made).toEqual([['send', true]]);
		expect(calls).toEqual([]);
	});

	test('keeps a change being saved while the connection is folded away', async () => {
		const {calls, onChange} = saves();
		const {rerender} = render(<Page actions={actions} defaults={[]} onChange={onChange} />);

		fireEvent.click(screen.getByRole('checkbox', {name: /Read/}));
		rerender(<Page actions={actions} defaults={[]} onChange={onChange} shown={false} />);
		rerender(<Page actions={actions} defaults={[]} onChange={onChange} />);
		expect(checked('Read')).toBe('true');
		fireEvent.click(screen.getByRole('checkbox', {name: /Read/}));
		expect(checked('Read')).toBe('false');

		await act(async () => {});
		await act(async () => calls[0]?.finish());
		expect(calls.map((call) => call.actions)).toEqual([{read: true}, {read: false}]);
	});
});

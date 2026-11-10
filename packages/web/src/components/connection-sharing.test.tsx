/// <reference types="bun" />

import type {Connection} from '@proxy/contracts/connections';
import type {Member} from '@proxy/contracts/orgs';
import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ConnectionSharing, type SharingChoice} from '@/components/connection-sharing';

afterEach(() => {
	cleanup();
});

const dana: Member = {
	userId: 'user-2',
	name: 'Dana',
	email: 'dana@example.com',
	image: null,
	role: 'member',
	joinedAt: '2026-10-01T00:00:00.000Z',
};
const sam: Member = {...dana, userId: 'user-3', name: null, email: 'sam@example.com'};

// A mailbox of Alex's, shared with whoever `with_` says.
function mailbox(
	with_: Partial<Pick<Connection, 'sharedWithEveryone' | 'sharedWith'>> = {},
): Connection {
	const sharedWithEveryone = with_.sharedWithEveryone ?? false;
	const sharedWith = with_.sharedWith ?? [];
	return {
		id: 'conn-1',
		orgId: 'org-1',
		integrationId: 'email',
		account: 'alex@example.com',
		ownerUserId: 'user-1',
		owner: 'Alex',
		sharedWithEveryone,
		sharedWith,
		shared: sharedWithEveryone || sharedWith.length > 0,
		builtIn: false,
		defaults: ['read'],
		tools: null,
		name: null,
		unavailable: [],
		signInNeeded: false,
	};
}

const alex: Member = {
	...dana,
	userId: 'user-1',
	name: 'Alex',
	email: 'alex@example.com',
	role: 'owner',
};

// The Sharing part of the mailbox's page, as Alex, whose it is, sees it; as Dana with `as`.
function renderSharing(
	connection: Connection,
	options: {mayChange?: boolean; alone?: boolean; as?: string; warning?: string} = {},
) {
	const onChange = mock(async (_sharing: SharingChoice) => {});
	const router = createMemoryRouter(
		[
			{
				path: '/:org/connections/:id',
				element: (
					<ConnectionSharing
						orgName="Acme"
						connection={connection}
						what="connection"
						members={[alex, dana, sam]}
						userId={options.as ?? 'user-1'}
						actsAs="alex@example.com"
						warning={options.warning}
						mayChange={options.mayChange ?? true}
						alone={options.alone ?? false}
						onChange={onChange}
					/>
				),
			},
		],
		{initialEntries: ['/acme/connections/conn-1']},
	);
	render(<RouterProvider router={router} />);
	return onChange;
}

// The people with access, as their rows say them: who, and what stands at the row's end.
function people(): string[] {
	return screen.getAllByRole('listitem').map((row) => row.textContent ?? '');
}

describe('ConnectionSharing', () => {
	test('lists the people with access, whoever’s it is first, and says who the provider sees', () => {
		renderSharing(mailbox({sharedWith: [{userId: 'user-2', name: 'Dana'}]}));

		expect(screen.getByText(/Agents use this connection as/).textContent).toContain(
			'alex@example.com',
		);
		expect(people()).toEqual([
			'AAlex · Youalex@example.comOwner',
			'DDanadana@example.comRemove',
			'Everyone in AcmeEvery member, now and later, and the shared agentsShare with everyone',
		]);
	});

	test('adds a member from those who don’t have it yet, once the person confirms, keeping whoever has it', async () => {
		const onChange = renderSharing(mailbox({sharedWith: [{userId: 'user-2', name: 'Dana'}]}));

		fireEvent.click(screen.getByRole('button', {name: 'Add people'}));
		const offered = await screen.findAllByRole('menuitem');
		expect(offered.map((item) => item.textContent)).toEqual(['Ssam@example.com']);
		fireEvent.click(offered[0]!);
		expect(onChange).not.toHaveBeenCalled();
		expect(
			await screen.findByText(/sam@example.com's agents can use it, as alex@example.com/),
		).toBeDefined();
		fireEvent.click(screen.getByRole('button', {name: 'Share'}));

		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith({everyone: false, userIds: ['user-2', 'user-3']}),
		);
	});

	test('where the integration warns of acting as the account, says so, and again before sharing', async () => {
		const warning = 'Whoever’s agents use it, what they push shows as this account’s.';
		renderSharing(mailbox(), {warning});

		expect(screen.getByText(warning)).toBeDefined();
		fireEvent.click(screen.getByRole('button', {name: 'Share with everyone'}));
		expect(
			await screen.findByText(
				/as alex@example.com, with what Permissions allows\. Members see it listed, never its password or token\. Whoever’s agents use it, what they push shows as this account’s\. You can stop sharing it at any time\./,
			),
		).toBeDefined();
	});

	test('with every member on the list already, there is nobody to add', () => {
		renderSharing(
			mailbox({
				sharedWith: [
					{userId: 'user-2', name: 'Dana'},
					{userId: 'user-3', name: 'sam@example.com'},
				],
			}),
		);

		expect(screen.queryByRole('button', {name: 'Add people'})).toBeNull();
	});

	test('shares it with every member once the person confirms, saying whom its agents act as', async () => {
		const onChange = renderSharing(mailbox());

		fireEvent.click(screen.getByRole('button', {name: 'Share with everyone'}));
		expect(
			await screen.findByText(/Every member's agents in Acme can use it, as alex@example.com/),
		).toBeDefined();
		fireEvent.click(screen.getByRole('button', {name: 'Share'}));

		await waitFor(() => expect(onChange).toHaveBeenCalledWith({everyone: true, userIds: []}));
	});

	test('takes it back at once, from a member or from everyone, without asking', async () => {
		const onChange = renderSharing(
			mailbox({sharedWithEveryone: true, sharedWith: [{userId: 'user-2', name: 'Dana'}]}),
		);

		expect(people().at(-1)).toBe(
			'Everyone in AcmeEvery member has it, and so do the shared agentsStop sharing',
		);
		fireEvent.click(screen.getByRole('button', {name: 'Remove Dana'}));
		await waitFor(() => expect(onChange).toHaveBeenCalledWith({everyone: true, userIds: []}));
		fireEvent.click(screen.getByRole('button', {name: 'Stop sharing'}));
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith({everyone: false, userIds: ['user-2']}),
		);
		expect(screen.queryByRole('button', {name: 'Share'})).toBeNull();
	});

	test('someone it is shared with sees who has it and changes nothing', () => {
		renderSharing(mailbox({sharedWith: [{userId: 'user-2', name: 'Dana'}]}), {
			mayChange: false,
			as: 'user-2',
		});

		expect(screen.getByText(/Only Alex changes it or shares it on/)).toBeDefined();
		expect(people()).toEqual(['AAlexalex@example.comOwner', 'DDana · Youdana@example.com']);
		expect(screen.queryByRole('button')).toBeNull();
	});

	test('alone in the organization, points to Members instead', () => {
		renderSharing(mailbox(), {alone: true});

		expect(screen.getByRole('link', {name: 'Invite people'}).getAttribute('href')).toBe(
			'/acme/members',
		);
		expect(screen.queryByRole('button')).toBeNull();
	});
});

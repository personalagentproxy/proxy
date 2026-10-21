/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {IntegrationCatalog, SignInFailed} from '@/components/integration-catalog';
import type {Connection} from '@/lib/types';

const GOOGLE_DOCS = 'https://docs.personalagentproxy.com/connections/google/';

const google: Connection = {
	id: 'conn-1',
	integrationId: 'google',
	orgId: 'org-1',
	shared: false,
	connectedById: 'user-1',
	connectedBy: null,
	account: 'alex@example.com',
	defaults: ['readFiles'],
	tools: null,
	name: null,
	unavailable: [],
	signInNeeded: false,
};

afterEach(() => {
	cleanup();
});

function renderCatalog(args: {
	google?: boolean;
	plaid?: boolean;
	connections?: Connection[];
	name?: string;
	onConnectForm?: (integrationId: string) => void;
}) {
	render(
		<TooltipProvider>
			<IntegrationCatalog
				connections={args.connections ?? []}
				configured={{google: args.google ?? true, plaid: args.plaid ?? true}}
				experiments={[]}
				onConnectForm={args.onConnectForm ?? mock()}
				onConnected={mock()}
			/>
		</TooltipProvider>,
	);
	const name = args.name ?? 'Google';
	const row = screen.getByText(name).closest('li');
	if (!row) {
		throw new Error(`The catalog has no ${name} row`);
	}
	return within(row);
}

describe('IntegrationCatalog', () => {
	test('Google without its client on the server is greyed out, saying what to set and where the docs are', () => {
		const row = renderCatalog({google: false, connections: [google]});

		// The row is neither a link nor a button: its only link is to the docs.
		expect(row.queryByRole('button')).toBeNull();
		expect(row.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
			GOOGLE_DOCS,
		]);
		expect(row.getByText(/Needs/).textContent).toBe(
			'Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server. See the docs.',
		);
		const docs = row.getByRole('link', {name: 'the docs'});
		expect(docs.getAttribute('href')).toBe(GOOGLE_DOCS);
		expect(docs.getAttribute('target')).toBe('_blank');
		expect(row.getByText('1 connected')).toBeDefined();
	});

	test('Google with its client on the server is signed in to with the whole row', () => {
		const row = renderCatalog({google: true});

		expect(row.getByRole('link').getAttribute('href')).toBe('/api/connections/google/start');
		expect(row.queryByText(/GOOGLE_CLIENT_ID/)).toBeNull();
	});

	test('Exa is signed in to with the row, and its key opens the API key dialog', () => {
		const row = renderCatalog({name: 'Exa'});

		expect(row.getByRole('link').getAttribute('href')).toBe('/api/connections/exa/start');
		// Its plus is a link of its own, since the key sits before it.
		expect(row.getByRole('button', {name: 'Sign in with Exa'}).getAttribute('href')).toBe(
			'/api/connections/exa/start',
		);
		fireEvent.click(row.getByRole('button', {name: 'Connect Exa with an API key'}));
		expect(screen.getByRole('dialog').textContent).toContain('Connect Exa with an API key');
		expect(screen.getByRole('link', {name: 'dashboard.exa.ai'}).getAttribute('href')).toBe(
			'https://dashboard.exa.ai/api-keys',
		);
	});

	test('a bank without Plaid’s keys on the server is greyed out, saying what to set', () => {
		const row = renderCatalog({plaid: false, name: 'Plaid'});

		expect(row.queryByRole('button')).toBeNull();
		expect(row.getByText(/Needs/).textContent).toBe(
			'Needs PLAID_CLIENT_ID and PLAID_SECRET on the server. See the docs.',
		);
	});

	test('a bank with Plaid’s keys on the server goes to its own page', () => {
		const onConnectForm = mock();
		const row = renderCatalog({name: 'Plaid', onConnectForm});

		fireEvent.click(row.getByRole('button'));
		expect(onConnectForm).toHaveBeenCalledWith('plaid');
	});
});

describe('SignInFailed', () => {
	test('a sign-in that could not start says what the server is missing', () => {
		render(<SignInFailed error="google-unconfigured" configured={{google: false, plaid: true}} />);

		expect(screen.getByText(/Needs/).textContent).toBe(
			'Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server. See the docs.',
		);
		expect(screen.getByRole('link', {name: 'the docs'}).getAttribute('href')).toBe(GOOGLE_DOCS);
	});

	test('says nothing of what the server was missing once it has it', () => {
		const {container} = render(
			<SignInFailed error="google-unconfigured" configured={{google: true, plaid: true}} />,
		);

		expect(container.textContent).toBe('');
	});

	test('a sign-in that failed says to try again', () => {
		render(<SignInFailed error="google" configured={{google: true, plaid: true}} />);

		expect(screen.getByText('Signing in to Google didn’t finish. Try again.')).toBeDefined();
	});
});

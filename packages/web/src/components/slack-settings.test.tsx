/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {useState} from 'react';
import {Err, Ok} from 'ts-results-es';
import type {FetchError} from '@proxy/utils';
import type {PersonaInSlack, PersonaSlack, SlackApp} from '@proxy/contracts/slack';

const getPersonaSlack =
	mock<(org: string, personaId: string) => Promise<Ok<PersonaSlack> | Err<FetchError>>>();
const linkSlackWorkspace = mock(
	async (_org: string, _tokens: {token: string; refreshToken: string}): Promise<Answer> =>
		Ok({workspace: {id: 'workspace-1', name: 'Northwind', needsToken: false, inUse: false}}),
);
const unlinkSlackWorkspace = mock(async (): Promise<Answer> => Ok(undefined));
const addToSlack = mock(
	async (
		_org: string,
		_personaId: string,
		_workspaceId: string,
	): Promise<Ok<{app: SlackApp; install: boolean}> | Err<FetchError>> =>
		Ok({app: waiting, install: true}),
);
const updateSlackApp = mock(
	async (
		_org: string,
		_personaId: string,
	): Promise<Ok<{app: SlackApp; install: boolean}> | Err<FetchError>> =>
		Ok({app: inSlack, install: false}),
);
const removeSlackApp = mock(
	async (_org: string, _personaId: string): Promise<Ok<undefined> | Err<FetchError>> =>
		Ok(undefined),
);
const forgetSlackApp = mock(async (_org: string, _personaId: string): Promise<Answer> =>
	Ok(undefined),
);
// The api, behind the real client: each call is handed to the mock for it, by its address and
// method, and its answer sent back as the api would send it.
type Answer = Ok<unknown> | Err<FetchError>;

function respond(answer: Answer): Response {
	if (answer.isErr()) {
		const error = answer.error;
		return Response.json(error.kind === 'http' ? error.body : {}, {
			status: error.kind === 'http' ? error.status : 500,
		});
	}
	return answer.value === undefined
		? new Response(null, {status: 204})
		: Response.json(answer.value);
}

async function api(path: string, init?: RequestInit): Promise<Response> {
	const method = init?.method ?? 'GET';
	const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
	const base = '/api/orgs/acme/chat/personas/persona-1/slack';
	if (path === '/api/orgs/acme/slack/workspaces') {
		return respond(await linkSlackWorkspace('acme', body));
	}
	if (path.startsWith('/api/orgs/acme/slack/workspaces/')) {
		return respond(await unlinkSlackWorkspace());
	}
	if (path === `${base}/update`) {
		return respond(await updateSlackApp('acme', 'persona-1'));
	}
	if (path === `${base}/forget`) {
		return respond(await forgetSlackApp('acme', 'persona-1'));
	}
	if (path === base && method === 'POST') {
		return respond(await addToSlack('acme', 'persona-1', body.workspaceId));
	}
	if (path === `${base}/presence`) {
		presenceAsked += 1;
		return Response.json(fetchPresence);
	}
	if (path === base && method === 'DELETE') {
		return respond(await removeSlackApp('acme', 'persona-1'));
	}
	return respond(await getPersonaSlack('acme', 'persona-1'));
}

const realFetch = globalThis.fetch;

// Where a member who may not change the agent writes to it in Slack, as the api answers.
let fetchPresence: PersonaInSlack = {inSlack: null};
let presenceAsked = 0;

const downloadHeadPicture = mock(async () => true);
mock.module('@/lib/head-picture', () => ({downloadHeadPicture}));

const {SlackDialog, SlackPresenceRow, SlackRow} = await import('@/components/slack-settings');
const {usePersonaSlack} = await import('@/hooks/use-persona-slack');

const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const waiting: SlackApp = {
	state: 'waiting',
	workspaceId: 'workspace-1',
	workspaceName: 'Northwind',
	handle: null,
	settingsUrl: 'https://api.slack.com/apps/A01/general',
};
const inSlack: SlackApp = {...waiting, state: 'in_slack', handle: 'finance'};
const northwind = {id: 'workspace-1', name: 'Northwind', needsToken: false, inUse: false};

const assign = mock();
const realLocation = window.location;

function answer(slack: Partial<PersonaSlack>) {
	getPersonaSlack.mockResolvedValue(
		Ok({workspaces: [northwind], app: null, unavailable: null, ...slack}),
	);
}

// The agent's Slack row, and the dialog its action opens, reading the agent in Slack alike, as
// the pane has them.
function Settings({shared, notice}: {shared: boolean; notice: 'installed' | 'enterprise' | null}) {
	const slack = usePersonaSlack('acme', 'persona-1', shared);
	const [open, setOpen] = useState(false);
	return (
		<>
			<SlackRow shared={shared} orgName="Acme" slack={slack} onOpen={() => setOpen(true)} />
			<SlackDialog
				open={open || notice !== null}
				onClose={() => setOpen(false)}
				org="acme"
				personaId="persona-1"
				name="Finance"
				look={look}
				color="blue"
				notice={notice}
				slack={slack}
			/>
		</>
	);
}

// The agent's settings with its Slack dialog open, by the row's action unless it opened on how an
// install ended.
async function show(props: {shared?: boolean; notice?: 'installed' | 'enterprise' | null} = {}) {
	render(<Settings shared={props.shared ?? true} notice={props.notice ?? null} />);
	if (props.shared === false || props.notice) {
		return;
	}
	const row = await screen.findByRole('region', {name: 'Slack'});
	await waitFor(() => expect(within(row).queryByText('Loading…')).toBeNull());
	const action = within(row).queryByRole('button');
	if (action !== null) {
		fireEvent.click(action);
	}
	await screen.findByRole('dialog');
}

beforeEach(() => {
	mock.clearAllMocks();
	presenceAsked = 0;
	globalThis.fetch = ((input: string, init?: RequestInit) => api(input, init)) as typeof fetch;
	Object.defineProperty(window, 'location', {configurable: true, value: {...realLocation, assign}});
});

afterEach(() => {
	cleanup();
	globalThis.fetch = realFetch;
	Object.defineProperty(window, 'location', {configurable: true, value: realLocation});
});

describe('the Slack row', () => {
	test('says in one line that a personal agent has to be shared first, asking nothing of the api', async () => {
		await show({shared: false});

		expect(screen.getByText('Share it with everyone in Acme to add it to Slack')).toBeTruthy();
		expect(screen.queryByRole('button')).toBeNull();
		expect(getPersonaSlack).not.toHaveBeenCalled();
	});

	test('says where the agent stands in Slack, with one action word for each state', async () => {
		const cases: Array<[Partial<PersonaSlack>, string, string]> = [
			[{}, 'Members message it there, as themselves', 'Add to Slack'],
			[{app: waiting}, 'Waiting to be installed in Northwind', 'Install'],
			[{app: inSlack}, '@finance in Northwind', 'Manage'],
			[{app: {...inSlack, state: 'out_of_date'}}, '@finance in Northwind, out of date', 'Update'],
			[{app: {...inSlack, state: 'removed'}}, 'Removed from Northwind in Slack', 'Add again'],
		];
		for (const [slack, line, action] of cases) {
			answer(slack);
			render(<Settings shared notice={null} />);
			const row = await screen.findByRole('region', {name: 'Slack'});
			expect(await within(row).findByText(line)).toBeTruthy();
			expect(within(row).getByRole('button', {name: action})).toBeTruthy();
			cleanup();
		}
	});

	test('opens the dialog from its action, and shows a change made there once the dialog has made it', async () => {
		answer({app: {...inSlack, state: 'removed'}});
		await show();

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByRole('heading', {name: 'Finance in Slack'})).toBeTruthy();
		answer({});
		fireEvent.click(within(dialog).getByRole('button', {name: 'Forget it here'}));

		// Under the dialog, which hides the page from a screen reader while it is open.
		const row = screen.getByRole('region', {name: 'Slack', hidden: true});
		expect(await within(row).findByText('Members message it there, as themselves')).toBeTruthy();
	});

	test('for a member who may not change the agent, says where to write to it in Slack, and nothing where it isn’t there', async () => {
		fetchPresence = {
			inSlack: {
				handle: 'finance',
				workspaceName: 'Northwind',
				slackUrl: 'https://slack.com/app_redirect?app=A01&team=T01',
			},
		};
		render(<SlackPresenceRow org="acme" personaId="persona-1" />);
		expect(await screen.findByText('@finance in Northwind')).toBeTruthy();
		expect(screen.getByRole('link', {name: 'Open in Slack'}).getAttribute('href')).toBe(
			'https://slack.com/app_redirect?app=A01&team=T01',
		);
		cleanup();

		fetchPresence = {inSlack: null};
		const {container} = render(<SlackPresenceRow org="acme" personaId="persona-1" />);
		await waitFor(() => expect(presenceAsked).toBeGreaterThan(1));
		expect(container.textContent).toBe('');
	});
});

describe('the Slack dialog', () => {
	test('with no workspace linked, asks for the two tokens and says where in Slack they come from, then links it', async () => {
		answer({workspaces: []});
		await show();

		expect(
			await screen.findByText(
				'Add Finance to Slack as an app of its own, which members write to there. Link a Slack workspace first.',
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole('button', {name: 'Link a Slack workspace'}));
		await screen.findByRole('group', {name: 'Link a Slack workspace'});
		expect(
			screen.getByText(/find Your App Configuration Tokens, choose Generate Token/),
		).toBeTruthy();
		expect(screen.getByRole('link', {name: 'api.slack.com/apps'}).getAttribute('href')).toBe(
			'https://api.slack.com/apps',
		);
		const link = screen.getByRole('button', {name: 'Link workspace'});
		expect(link.hasAttribute('disabled')).toBe(true);

		fireEvent.change(screen.getByLabelText('Access token'), {target: {value: ' xoxe.xoxp-1 '}});
		fireEvent.change(screen.getByLabelText('Refresh token'), {target: {value: 'xoxe-1-1'}});
		answer({});
		fireEvent.click(link);

		await waitFor(() =>
			expect(linkSlackWorkspace).toHaveBeenCalledWith('acme', {
				token: 'xoxe.xoxp-1',
				refreshToken: 'xoxe-1-1',
			}),
		);
		await screen.findByRole('button', {name: 'Add to Northwind'});
	});

	test('asks for the token again where Slack no longer takes a workspace’s', async () => {
		answer({workspaces: [{...northwind, needsToken: true}]});
		await show();

		expect(
			await screen.findByText(/Slack no longer takes the token Northwind was linked with/),
		).toBeTruthy();
	});

	test('adds the agent to the linked workspace and sends the browser through Slack’s install', async () => {
		answer({});
		await show();

		fireEvent.click(await screen.findByRole('button', {name: 'Add to Northwind'}));

		await waitFor(() =>
			expect(assign).toHaveBeenCalledWith('/api/orgs/acme/chat/personas/persona-1/slack/install'),
		);
		expect(addToSlack).toHaveBeenCalledWith('acme', 'persona-1', 'workspace-1');
	});

	test('says what Slack refused adding it with, and why it can’t be added on a server without https', async () => {
		answer({});
		addToSlack.mockResolvedValueOnce(
			Err({
				kind: 'http',
				url: '/x',
				status: 409,
				body: {error: 'conflict', message: 'Northwind’s Slack plan has no room for another app.'},
			}),
		);
		await show();
		fireEvent.click(await screen.findByRole('button', {name: 'Add to Northwind'}));
		expect(
			await screen.findByText('Northwind’s Slack plan has no room for another app.'),
		).toBeTruthy();
		expect(assign).not.toHaveBeenCalled();
		cleanup();

		answer({unavailable: 'Slack only sends to https addresses.'});
		await show();
		expect(await screen.findByText('Slack only sends to https addresses.')).toBeTruthy();
		expect(screen.queryByRole('button', {name: 'Add to Northwind'})).toBeNull();
	});

	test('shows an app waiting to be installed or approved, with the install to try again', async () => {
		answer({app: waiting});
		await show();

		expect(
			await screen.findByText(/waiting to be installed\. Where a Slack admin has to approve apps/),
		).toBeTruthy();
		fireEvent.click(screen.getByRole('button', {name: 'Install'}));
		expect(assign).toHaveBeenCalledWith('/api/orgs/acme/chat/personas/persona-1/slack/install');
	});

	test('shows an app in Slack by its workspace and handle, and saves its head as the app’s picture', async () => {
		answer({app: inSlack});
		await show({notice: 'installed'});

		expect(
			await screen.findByText(
				'Finance is in Northwind as @finance. Members write to it there, in its Messages tab.',
			),
		).toBeTruthy();
		expect(screen.getByText('Finance is in Slack.')).toBeTruthy();
		expect(screen.getByRole('link', {name: 'the app’s settings'}).getAttribute('href')).toBe(
			'https://api.slack.com/apps/A01/general',
		);

		fireEvent.click(screen.getByRole('button', {name: 'its head as a picture'}));
		await waitFor(() =>
			expect(downloadHeadPicture).toHaveBeenCalledWith({look, color: 'blue'}, 'Finance'),
		);
	});

	test('offers an update for an app out of date, through the install where Slack asks for it', async () => {
		answer({app: {...inSlack, state: 'out_of_date'}});
		await show();

		fireEvent.click(await screen.findByRole('button', {name: 'Update'}));
		await waitFor(() => expect(updateSlackApp).toHaveBeenCalledWith('acme', 'persona-1'));
		expect(assign).not.toHaveBeenCalled();

		updateSlackApp.mockResolvedValueOnce(
			Ok({app: {...inSlack, state: 'out_of_date'}, install: true}),
		);
		fireEvent.click(await screen.findByRole('button', {name: 'Update'}));
		await waitFor(() =>
			expect(assign).toHaveBeenCalledWith('/api/orgs/acme/chat/personas/persona-1/slack/install'),
		);
	});

	test('offers to add an app removed in Slack again, or to forget it', async () => {
		answer({app: {...inSlack, state: 'removed'}});
		await show();

		expect(
			await screen.findByText('Removed from Northwind in Slack. Add it again, or forget it here.'),
		).toBeTruthy();
		fireEvent.click(screen.getByRole('button', {name: 'Forget it here'}));
		await waitFor(() => expect(forgetSlackApp).toHaveBeenCalledWith('acme', 'persona-1'));
		expect(removeSlackApp).not.toHaveBeenCalled();
	});

	test('removes it from Slack, and where Slack can’t, offers to forget it here, saying it may stay there', async () => {
		answer({app: inSlack});
		removeSlackApp.mockResolvedValueOnce(
			Err({
				kind: 'http',
				url: '/x',
				status: 502,
				body: {
					error: 'provider_unreachable',
					message: 'Slack can’t be reached right now. Try again in a moment.',
				},
			}),
		);
		await show();

		fireEvent.click(await screen.findByRole('button', {name: 'Remove from Slack'}));

		expect(
			await screen.findByText('Slack can’t be reached right now. Try again in a moment.'),
		).toBeTruthy();
		expect(
			screen.getByText(
				'Forgetting it here leaves the app in Northwind, for a Slack admin there to delete.',
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole('button', {name: 'Forget it here'}));
		await waitFor(() => expect(forgetSlackApp).toHaveBeenCalledWith('acme', 'persona-1'));
	});

	test('says an install across a whole Enterprise organization isn’t supported', async () => {
		answer({app: waiting});
		await show({notice: 'enterprise'});

		expect(
			await screen.findByText(
				'Slack installed it across a whole Enterprise organization, which isn’t supported. Install it in one workspace.',
			),
		).toBeTruthy();
	});
});

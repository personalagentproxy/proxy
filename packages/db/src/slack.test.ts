import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {createPersona, listPersonas, sharePersona, takeBackPersona} from './harness';
import {
	claimDueSlackWorkspaces,
	finishSlackApp,
	forgetSlackApp,
	getPersonaSlackApp,
	getSlackAppForEvents,
	installSlackApp,
	linkSlackWorkspace,
	listSlackWorkspaces,
	markSlackAppRemoved,
	refuseSlackWorkspace,
	rotateSlackWorkspace,
	startSlackApp,
	unlinkSlackWorkspace,
} from './slack';

// Slack's workspaces and apps against the local database: run with it up (`bun run dev`) and the
// environment loaded, `bun --env-file=../../.env test src/slack.test.ts` from this package.
// Without DATABASE_URL, as `bun run test` runs, it is skipped. Everything made here is one
// organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
const HOUR = 60 * 60 * 1000;

describe.skipIf(!databaseUrl)('Slack workspaces and apps, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let maker = '';
	let orgId = '';
	let workspaceId = '';

	beforeAll(async () => {
		maker = (await db.user.create({data: {email: `slack-test-${stamp}@example.test`}})).id;
		orgId = (
			await db.organization.create({
				data: {name: 'Slack test', slug: `slack-test-${stamp}`, ownerUserId: maker},
			})
		).id;
		await db.orgMember.create({data: {orgId, userId: maker}});
	});

	afterAll(async () => {
		await db.slackApp.deleteMany({where: {orgId}});
		await db.slackWorkspace.deleteMany({where: {orgId}});
		await db.organization.deleteMany({where: {id: orgId}});
		await db.user.deleteMany({where: {id: maker}});
		await db.$disconnect();
	});

	function link(teamId: string, expiresAt: Date) {
		return linkSlackWorkspace({
			orgId,
			teamId,
			name: `Workspace ${teamId}`,
			slackUserId: 'U01',
			linkedById: maker,
			credential: 'sealed-1',
			expiresAt,
			rotateAt: new Date(expiresAt.getTime() - 2 * HOUR),
		}).then(unwrap);
	}

	test('links a workspace once per organization, a second link giving it its new token and clearing a refusal', async () => {
		const first = await link(`T-${stamp}`, new Date(Date.now() + 12 * HOUR));
		workspaceId = first.id;
		unwrap(await refuseSlackWorkspace(workspaceId));

		const again = unwrap(
			await linkSlackWorkspace({
				orgId,
				teamId: `T-${stamp}`,
				name: 'Northwind',
				slackUserId: 'U02',
				linkedById: maker,
				credential: 'sealed-2',
				expiresAt: new Date(Date.now() + 12 * HOUR),
				rotateAt: new Date(),
			}),
		);

		expect(again.id).toBe(workspaceId);
		expect(again).toMatchObject({name: 'Northwind', credential: 'sealed-2', refusedAt: null});
		expect(unwrap(await listSlackWorkspaces(orgId)).map(({id, apps}) => [id, apps])).toEqual([
			[workspaceId, 0],
		]);
	});

	test('the sweep takes a workspace due once, moved on by its lease, and never one Slack turned down', async () => {
		const due = await link(`T-due-${stamp}`, new Date(Date.now() + HOUR));
		const refused = await link(`T-refused-${stamp}`, new Date(Date.now() + HOUR));
		unwrap(await refuseSlackWorkspace(refused.id));

		const first = unwrap(await claimDueSlackWorkspaces(5 * 60 * 1000, 100));
		const second = unwrap(await claimDueSlackWorkspaces(5 * 60 * 1000, 100));

		expect(first).toContain(due.id);
		expect(first).not.toContain(refused.id);
		expect(second).not.toContain(due.id);
		unwrap(await unlinkSlackWorkspace(orgId, due.id));
		unwrap(await unlinkSlackWorkspace(orgId, refused.id));
	});

	test('rotates under a lock, so two rotations at once spend the refresh token once', async () => {
		const row = await link(`T-rotate-${stamp}`, new Date(Date.now() + 60 * 1000));
		let spent = 0;
		const rotate = () =>
			rotateSlackWorkspace(row.id, async (held) => {
				if (held.expiresAt.getTime() > Date.now() + 10 * 60 * 1000) {
					return {kind: 'fresh'};
				}
				spent += 1;
				await new Promise((resolve) => setTimeout(resolve, 50));
				return {
					kind: 'rotated',
					credential: `sealed-${spent}`,
					expiresAt: new Date(Date.now() + 12 * HOUR),
					rotateAt: new Date(Date.now() + 10 * HOUR),
				};
			});

		const [one, two] = await Promise.all([rotate(), rotate()]);

		expect(spent).toBe(1);
		expect([unwrap(one)?.rotation.kind, unwrap(two)?.rotation.kind].toSorted()).toEqual([
			'fresh',
			'rotated',
		]);
		expect(unwrap(two)?.row.credential).toBe('sealed-1');

		const refused = unwrap(await rotateSlackWorkspace(row.id, async () => ({kind: 'refused'})));
		expect(refused?.row.refusedAt).not.toBeNull();
		unwrap(await unlinkSlackWorkspace(orgId, row.id));
	});

	test('makes an app only for a shared persona, one each, and keeps a persona in Slack shared, its workspace linked, until the app is forgotten', async () => {
		const finance = unwrap(
			await createPersona(orgId, maker, {name: 'Finance', look, color: 'teal'}),
		);
		const app = {
			orgId,
			personaId: finance.id,
			workspaceId,
			manifestVersion: 1,
			manifestName: 'Finance',
			addedById: maker,
		};

		expect(unwrap(await startSlackApp(app))).toEqual({kind: 'not_shared'});
		unwrap(await sharePersona(orgId, maker, finance.id));
		expect(unwrap(await startSlackApp({...app, workspaceId: 'gone'}))).toEqual({
			kind: 'no_workspace',
		});

		const started = unwrap(await startSlackApp(app));
		expect(started.kind).toBe('started');
		expect(unwrap(await startSlackApp(app))).toEqual({kind: 'exists'});
		const id = started.kind === 'started' ? started.app.id : '';

		// Slack may check the address before the secret is kept.
		expect(unwrap(await getSlackAppForEvents(id))).toMatchObject({
			secrets: null,
			org: {experiments: [], insider: false},
		});
		unwrap(
			await finishSlackApp(id, {slackAppId: `A-${stamp}`, clientId: '111.222', secrets: 'sealed'}),
		);
		unwrap(
			await installSlackApp(id, {
				botToken: 'sealed-bot',
				botUserId: 'U0BOT',
				botName: 'finance',
				scopes: ['chat:write'],
				workspaceName: 'Northwind Traders',
			}),
		);
		expect(unwrap(await getPersonaSlackApp(finance.id))).toMatchObject({
			slackAppId: `A-${stamp}`,
			botName: 'finance',
			removedAt: null,
		});
		expect(
			unwrap(await listSlackWorkspaces(orgId)).find(({id: linked}) => linked === workspaceId),
		).toMatchObject({name: 'Northwind Traders', apps: 1});

		expect(
			unwrap(await listPersonas(orgId, maker)).find(({id: listed}) => listed === finance.id)
				?.inSlack,
		).toBe(true);
		expect(unwrap(await takeBackPersona(orgId, maker, finance.id))).toBe('in_slack');
		expect(unwrap(await unlinkSlackWorkspace(orgId, workspaceId))).toBe('in_use');

		unwrap(await markSlackAppRemoved(id));
		expect(unwrap(await getPersonaSlackApp(finance.id))).toMatchObject({botToken: null});
		expect(unwrap(await getPersonaSlackApp(finance.id))?.removedAt).not.toBeNull();

		expect(unwrap(await forgetSlackApp(id))).toBe(true);
		expect(unwrap(await takeBackPersona(orgId, maker, finance.id))).toBe('taken');
		expect(unwrap(await unlinkSlackWorkspace(orgId, workspaceId))).toBe('unlinked');
		expect(unwrap(await unlinkSlackWorkspace(orgId, workspaceId))).toBe('missing');
	});
});

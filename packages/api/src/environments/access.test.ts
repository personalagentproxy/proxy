import express from 'express';
import {beforeEach, expect, mock, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';
import {ApiErr, type ApiError} from '@proxy/utils';
import type {OrgViewer} from '../utils/user-org';
import type {AgentRequest} from '../server/middleware/require-agent';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';

const owner: OrgViewer = {orgId: 'org-a', userId: 'owner', slug: 'acme', name: 'Acme', role: 'owner', onboarded: true, experiments: []};
const requireOwner = mock(async (): Promise<Result<OrgViewer, ApiError>> => Ok(owner));
const findUnique = mock();
const findFirst = mock();
const upsert = mock();
const create = mock();
const findMany = mock();
const deleteMany = mock();
const update = mock();
const grantFindMany = mock();
const grantUpsert = mock();
const transaction = {
	developmentEnvironmentPersonGrant: {findMany: async () => [], update: async () => ({})},
	developmentEnvironmentKey: {deleteMany: async () => ({count: 0})},
	developmentEnvironment: {findUnique, upsert},
	developmentEnvironmentGrant: {findMany: grantFindMany, update, upsert: grantUpsert},
	agent: {findFirst},
};
mock.module('@proxy/db', () => ({
	db: {
		...transaction,
		developmentEnvironment: {...transaction.developmentEnvironment, findMany, deleteMany},
		environmentAccess: {create, findMany},
		$transaction: (body: (tx: typeof transaction) => Promise<object | boolean | void>) => body(transaction),
	},
}));
mock.module('../utils/user-org', () => ({requireOwner}));
const decryptSecret = mock((value: string): Result<string, ApiError> => Ok(value));
mock.module('../utils/secret-crypto', () => ({encryptSecret: (value: string) => Ok('encrypted:' + value), decryptSecret}));
const {readEnvironment, saveEnvironment, grantEnvironment, listEnvironments, deleteEnvironment, listEnvironmentAccess} = await import('./route');

function agentRequest(): AgentRequest {
	return Object.assign(Object.create(express.request), {params: {project: 'example'}, agent: {agentId: 'agent-a', orgId: 'org-a'}, res: {setHeader: mock()}});
}
function ownerRequest(body: object = {}): AuthenticatedRequest {
	return Object.assign(Object.create(express.request), {params: {project: 'example'}, body});
}
beforeEach(() => {
	for (const fn of [findUnique, findFirst, upsert, create, findMany, deleteMany, update, grantFindMany, grantUpsert, decryptSecret, requireOwner]) {
		fn.mockClear();
	}
	requireOwner.mockResolvedValue(Ok(owner));
	findUnique.mockResolvedValue({id: 'env-a', names: ['PUBLIC', 'SECRET'], ciphertext: '{"PUBLIC":"visible","SECRET":"hidden"}', grants: [{names: ['PUBLIC']}]});
	findFirst.mockResolvedValue({id: 'agent-a'});
	create.mockResolvedValue({});
	findMany.mockResolvedValue([]);
	grantFindMany.mockResolvedValue([]);
	upsert.mockResolvedValue({id: 'env-a'});
	decryptSecret.mockImplementation((value) => Ok(value));
});

test('runtime returns only granted names and records metadata without values', async () => {
	const result = await readEnvironment(agentRequest());
	expect(result.unwrap()).toEqual({variables: {PUBLIC: 'visible'}});
	expect(findUnique.mock.calls[0]?.[0]).toMatchObject({where: {orgId_project: {orgId: 'org-a', project: 'example'}}, include: {grants: {where: {agentId: 'agent-a'}}}});
	expect(create.mock.calls[0]?.[0]).toEqual({data: {orgId: 'org-a', agentId: 'agent-a', project: 'example', names: ['PUBLIC'], allowed: true}});
	expect(JSON.stringify(create.mock.calls)).not.toContain('visible');
});
test('missing bundle and revoked grant both deny before decryption', async () => {
	for (const environment of [null, {names: ['PUBLIC'], grants: []}, {names: ['PUBLIC'], grants: [{names: []}]}]) {
		findUnique.mockResolvedValue(environment);
		expect((await readEnvironment(agentRequest())).unwrapErr().kind).toBe('forbidden');
	}
	expect(decryptSecret).not.toHaveBeenCalled();
});
test('stale names cannot authorize access', async () => {
	findUnique.mockResolvedValue({names: ['PUBLIC'], grants: [{names: ['REMOVED']}]});
	expect((await readEnvironment(agentRequest())).unwrapErr().kind).toBe('forbidden');
});
test('failed audit write prevents secret delivery', async () => {
	create.mockRejectedValueOnce(new Error('database unavailable'));
	expect((await readEnvironment(agentRequest())).isErr()).toBe(true);
	expect(decryptSecret).not.toHaveBeenCalled();
});
test('all management endpoints require organization ownership', async () => {
	requireOwner.mockResolvedValue(Err(ApiErr.forbidden()));
	for (const handler of [saveEnvironment, grantEnvironment, listEnvironments, deleteEnvironment, listEnvironmentAccess]) {
		expect((await handler(ownerRequest())).unwrapErr().kind).toBe('forbidden');
	}
	expect(findUnique).not.toHaveBeenCalled();
	expect(upsert).not.toHaveBeenCalled();
	expect(findMany).not.toHaveBeenCalled();
	expect(deleteMany).not.toHaveBeenCalled();
});
test('grant refuses foreign or revoked agents and nonexistent variable names', async () => {
	findFirst.mockResolvedValue(null);
	expect((await grantEnvironment(ownerRequest({agentId: 'foreign', names: ['PUBLIC']}))).unwrapErr().kind).toBe('forbidden');
	expect(findFirst.mock.calls[0]?.[0]).toEqual({where: {id: 'foreign', orgId: 'org-a', revokedAt: null}});
	findFirst.mockResolvedValue({id: 'agent-a'});
	expect((await grantEnvironment(ownerRequest({agentId: 'agent-a', names: ['MISSING']}))).unwrapErr().kind).toBe('forbidden');
	expect(grantUpsert).not.toHaveBeenCalled();
});
test('empty grant explicitly revokes access', async () => {
	expect((await grantEnvironment(ownerRequest({agentId: 'agent-a', names: []}))).isOk()).toBe(true);
	expect(grantUpsert.mock.calls[0]?.[0]).toMatchObject({update: {names: []}});
});
test('save encrypts values and prunes removed grants', async () => {
	grantFindMany.mockResolvedValue([{agentId: 'agent-a', names: ['PUBLIC', 'SECRET']}]);
	expect((await saveEnvironment(ownerRequest({PUBLIC: 'replacement'}))).unwrap()).toEqual({project: 'example', names: ['PUBLIC']});
	expect(upsert.mock.calls[0]?.[0]).toMatchObject({create: {ciphertext: 'encrypted:{"PUBLIC":"replacement"}'}});
	expect(update.mock.calls[0]?.[0]).toMatchObject({data: {names: ['PUBLIC']}});
});

import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const getAgentForSignIn = mock();
const createAgentSession = mock();
const deleteAgentSession = mock();
const getSignedInAgent = mock();

mock.module('@proxy/db/agent', () => ({getAgentForSignIn, createAgentSession, deleteAgentSession, getSignedInAgent}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'development'}}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const passwordHash = await Bun.password.hash('right-password');

function makeResponse() {
	const response = {
		statusCode: 200,
		body: undefined as unknown,
		cookies: [] as Array<{name: string; value: string}>,
		status(code: number) {
			response.statusCode = code;
			return response;
		},
		json(body: unknown) {
			response.body = body;
			return response;
		},
		cookie(name: string, value: string) {
			response.cookies.push({name, value});
			return response;
		},
	};
	return response;
}

beforeEach(() => {
	mock.clearAllMocks();
	getAgentForSignIn.mockResolvedValue(Ok({id: 'agent-1', passwordHash, revokedAt: null}));
	createAgentSession.mockResolvedValue(Ok(undefined));
});

describe('handleAgentLoginRoute', () => {
	test('signs in with the right password and stores only the token hash', async () => {
		const {handleAgentLoginRoute} = await import('./session');
		const response = makeResponse();
		await handleAgentLoginRoute({body: {username: 'shopping-agent-m3xd', password: 'right-password'}, ip: '10.0.0.1'} as never, response as never);

		expect(response.statusCode).toBe(200);
		const [cookie] = response.cookies;
		expect(cookie?.name).toBe('proxy.agent-session');
		const stored = createAgentSession.mock.calls[0]?.[0];
		expect(stored.agentId).toBe('agent-1');
		expect(stored.tokenHash).not.toBe(cookie?.value);
		expect(stored.tokenHash).toBe(new Bun.CryptoHasher('sha256').update(cookie?.value ?? '').digest('hex'));
	});

	test('a wrong password is unauthenticated', async () => {
		const {handleAgentLoginRoute} = await import('./session');
		const response = makeResponse();
		await handleAgentLoginRoute({body: {username: 'shopping-agent-m3xd', password: 'wrong'}, ip: '10.0.0.2'} as never, response as never);

		expect(response.statusCode).toBe(401);
		expect(createAgentSession).not.toHaveBeenCalled();
	});

	test('an unknown username is unauthenticated, the same as a wrong password', async () => {
		getAgentForSignIn.mockResolvedValue(Ok(null));

		const {handleAgentLoginRoute} = await import('./session');
		const response = makeResponse();
		await handleAgentLoginRoute({body: {username: 'nobody', password: 'right-password'}, ip: '10.0.0.3'} as never, response as never);

		expect(response.statusCode).toBe(401);
	});

	test('a revoked login is refused even with the right password', async () => {
		getAgentForSignIn.mockResolvedValue(Ok({id: 'agent-1', passwordHash, revokedAt: new Date()}));

		const {handleAgentLoginRoute} = await import('./session');
		const response = makeResponse();
		await handleAgentLoginRoute({body: {username: 'shopping-agent-m3xd', password: 'right-password'}, ip: '10.0.0.1'} as never, response as never);

		expect(response.statusCode).toBe(403);
		expect(createAgentSession).not.toHaveBeenCalled();
	});
});

describe('sign-in limits', () => {
	test('a username is locked for a while after too many wrong passwords', async () => {
		const {handleAgentLoginRoute} = await import('./session');
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 21; attempt++) {
			const response = makeResponse();
			await handleAgentLoginRoute({body: {username: 'guessed-at', password: 'wrong'}, ip: `10.1.0.${attempt}`} as never, response as never);
			statuses.push(response.statusCode);
		}

		expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
		expect(statuses[20]).toBe(429);
	});

	test('an address is held back after too many attempts', async () => {
		const {handleAgentLoginRoute} = await import('./session');
		let last = 0;
		for (let attempt = 0; attempt < 21; attempt++) {
			const response = makeResponse();
			await handleAgentLoginRoute({body: {username: `agent-${attempt}`, password: 'wrong'}, ip: '10.2.0.1'} as never, response as never);
			last = response.statusCode;
		}

		expect(last).toBe(429);
	});
});

describe('authenticateAgentRequest', () => {
	test('looks the session up by the hash of the cookie', async () => {
		getSignedInAgent.mockResolvedValue(Ok({agentId: 'agent-1', orgId: 'org-1', name: 'Shopping agent'}));

		const {authenticateAgentRequest} = await import('./session');
		const result = await authenticateAgentRequest({cookie: 'proxy.agent-session=abc'});

		expect(result.unwrap().agentId).toBe('agent-1');
		expect(getSignedInAgent).toHaveBeenCalledWith(new Bun.CryptoHasher('sha256').update('abc').digest('hex'));
	});

	test('no cookie is unauthenticated', async () => {
		const {authenticateAgentRequest} = await import('./session');
		const result = await authenticateAgentRequest({});

		expect(result.unwrapErr().kind).toBe('unauthenticated');
	});
});

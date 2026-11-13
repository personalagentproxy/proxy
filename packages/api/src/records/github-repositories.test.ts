import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

const markCredentialRejected = mock(async () => Ok(true));
mock.module('@proxy/db/connection', () => ({markCredentialRejected, updateConnectionCredential: mock(async () => Ok(true)), getConnectionCredential: mock(async () => Ok(null))}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({
	env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GITHUB_CLIENT_ID: 'Iv23client', GITHUB_CLIENT_SECRET: 'secret-1', GITHUB_APP_SLUG: 'personal-agent-proxy'},
}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

const {repositoriesConnector} = await import('./github-repositories');

function repositories(): Collection {
	const integration = findIntegration('github');
	const found = integration && findCollection(integration, 'repositories');
	if (!found) {
		throw new Error('No repositories collection');
	}
	return found;
}

const CREDENTIAL = {
	accessToken: 'ghu_access1',
	refreshToken: 'ghr_1',
	expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	id: '4242',
	login: 'alexkim',
	name: 'Alex Kim',
};

const target = {
	connection: {
		id: 'github-1',
		integrationId: 'github',
		orgId: 'org-1',
		ownerUserId: 'user-1',
		sharedWithEveryone: false,
		shares: [],
		account: 'alexkim',
		createdAt: new Date(),
		tools: null,
		name: null,
		defaults: [],
		credentialRejectedAt: null,
		credential: `enc:${JSON.stringify(CREDENTIAL)}`,
	},
	collection: repositories(),
};

function repository(fullName: string, extra: object = {}): object {
	return {
		full_name: fullName,
		description: `About ${fullName}`,
		private: false,
		default_branch: 'main',
		language: 'TypeScript',
		html_url: `https://github.com/${fullName}`,
		pushed_at: '2026-11-01T10:00:00Z',
		updated_at: '2026-11-02T10:00:00Z',
		...extra,
	};
}

// GitHub's API: what each installation lists, a hundred to a page.
function installation(id: number, login: string, type: 'User' | 'Organization', selection: 'all' | 'selected' = 'selected'): object {
	return {id, account: {login, type}, repository_selection: selection, html_url: `https://github.com/settings/installations/${id}`};
}

const INSTALLATIONS = [installation(11, 'acme', 'Organization'), installation(22, 'alexkim', 'User')];

const github = {requests: [] as URL[], installations: INSTALLATIONS, pages: {} as Record<string, object[]>, repo: null as object | null};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	github.requests.push(url);
	if (url.pathname === '/user/installations') {
		return Response.json({total_count: github.installations.length, installations: github.installations});
	}
	const listed = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
	if (listed) {
		const page = github.pages[`${listed[1]}:${url.searchParams.get('page')}`] ?? [];
		return Response.json({total_count: page.length, repositories: page});
	}
	if (url.pathname.startsWith('/repos/')) {
		return github.repo === null ? Response.json({message: 'Not Found'}, {status: 404}) : Response.json(github.repo);
	}
	return new Response('Not found', {status: 404});
}) as typeof fetch);

beforeEach(() => {
	github.requests = [];
	github.installations = INSTALLATIONS;
	github.pages = {'11:1': [repository('acme/api'), repository('acme/web', {private: true, language: null, description: null})], '22:1': [repository('alexkim/notes')]};
	github.repo = null;
});

const query = {search: null, page: null, filter: null, parent: null};

describe('repositoriesConnector.list', () => {
	test('lists the first installation’s repositories as records, pointing at the next installation', async () => {
		const page = (await repositoriesConnector.list(target, query)).unwrap();

		expect(github.requests.map((url) => url.pathname + url.search)).toEqual(['/user/installations?per_page=100', '/user/installations/11/repositories?per_page=100&page=1']);
		expect(page.records).toEqual([
			{
				id: 'acme/api',
				values: {fullName: 'acme/api', description: 'About acme/api', visibility: 'Public', defaultBranch: 'main', language: 'TypeScript', pushed: '2026-11-01T10:00:00Z'},
				updatedAt: '2026-11-01T10:00:00Z',
				url: 'https://github.com/acme/api',
			},
			expect.objectContaining({id: 'acme/web', values: expect.objectContaining({visibility: 'Private', language: '', description: ''})}),
		]);
		expect(page.nextPage).toBe('22:1');
	});

	test('goes on to the next installation from where the last page pointed, and a full page to the next page of the same', async () => {
		const second = (await repositoriesConnector.list(target, {...query, page: '22:1'})).unwrap();
		expect(second.records.map((record) => record.id)).toEqual(['alexkim/notes']);
		expect(second.nextPage).toBeNull();

		github.pages['11:1'] = Array.from({length: 100}, (_, i) => repository(`acme/repo-${i}`));
		const full = (await repositoriesConnector.list(target, query)).unwrap();
		expect(full.records.length).toBe(100);
		expect(full.nextPage).toBe('11:2');
	});

	test('a page token that isn’t one of its own, or of an installation gone since, is refused', async () => {
		expect((await repositoriesConnector.list(target, {...query, page: 'nonsense'})).unwrapErr().kind).toBe('validation_error');
		expect((await repositoriesConnector.list(target, {...query, page: '99:1'})).unwrapErr().kind).toBe('validation_error');
	});

	test('with the app installed nowhere the person reaches, says to install it rather than listing nothing', async () => {
		github.installations = [];
		const refused = (await repositoriesConnector.list(target, query)).unwrapErr();
		expect(refused.kind).toBe('validation_error');
		expect(refused.kind === 'validation_error' ? refused.message : '').toContain('Install it at https://github.com/apps/personal-agent-proxy/installations/new');
	});
});

describe('repositoriesConnector.get', () => {
	test('opens a repository its owner’s installation picked, from the installation’s list, whatever its case', async () => {
		const record = (await repositoriesConnector.get(target, 'Acme/API')).unwrap();

		expect(github.requests.map((url) => url.pathname + url.search)).toEqual(['/user/installations?per_page=100', '/user/installations/11/repositories?per_page=100&page=1']);
		expect(record).toMatchObject({id: 'acme/api', url: 'https://github.com/acme/api'});
	});

	test('pages through an installation of some repositories for it', async () => {
		github.pages['11:1'] = Array.from({length: 100}, (_, i) => repository(`acme/repo-${i}`));
		github.pages['11:2'] = [repository('acme/late')];

		expect((await repositoriesConnector.get(target, 'acme/late')).unwrap().id).toBe('acme/late');
		expect(github.requests.map((url) => url.searchParams.get('page'))).toEqual([null, '1', '2']);
	});

	test('a public repository the app isn’t installed on is not found, though GitHub would show it', async () => {
		github.repo = repository('acme/public');
		expect((await repositoriesConnector.get(target, 'acme/public')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});

		github.repo = repository('octocat/hello-world');
		expect((await repositoriesConnector.get(target, 'octocat/hello-world')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
		expect(github.requests.some((url) => url.pathname.startsWith('/repos/'))).toBe(false);
	});

	test('opens one of an owner whose installation covers all its repositories from GitHub, unless it moved to another owner', async () => {
		github.installations = [installation(11, 'acme', 'Organization', 'all')];
		github.repo = repository('acme/api');
		expect((await repositoriesConnector.get(target, 'acme/api')).unwrap()).toMatchObject({id: 'acme/api'});
		expect(github.requests.map((url) => url.pathname)).toEqual(['/user/installations', '/repos/acme/api']);

		github.repo = repository('elsewhere/api');
		expect((await repositoriesConnector.get(target, 'acme/api')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});

		github.repo = null;
		expect((await repositoriesConnector.get(target, 'acme/gone')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
	});

	test('an id that isn’t a repository’s is not found without asking GitHub', async () => {
		expect((await repositoriesConnector.get(target, 'not a repository')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
		expect(github.requests.length).toBe(0);
	});
});

import {describe, expect, test} from 'bun:test';

import {operationRun} from './graphql';
import {apiAction, apiRequest, gitAction, gitRequest, graphqlAction, isGraphql, upstreamUrl} from './requests';

const GIT = 'https://github.com';
const API = 'https://api.github.com';

function graphql(query: string, operationName?: string | null): Buffer {
	return Buffer.from(JSON.stringify(operationName === undefined ? {query} : {query, operationName}));
}

describe('git requests', () => {
	test('smart HTTP of a repository, with or without .git, goes to GitHub as <owner>/<repo>.git', () => {
		const refs = gitRequest('GET', '/acme/demo/info/refs?service=git-upload-pack', GIT).unwrap();
		const fetch = gitRequest('POST', '/acme/demo.git/git-upload-pack', GIT).unwrap();
		const push = gitRequest('POST', '/acme/my.repo_1.git/git-receive-pack', GIT).unwrap();
		const pushRefs = gitRequest('GET', '/acme/demo.git/info/refs?service=git-receive-pack', GIT).unwrap();

		expect(refs).toEqual({service: 'git-upload-pack', phase: 'refs', repository: 'acme/demo', url: new URL('https://github.com/acme/demo.git/info/refs?service=git-upload-pack')});
		expect(fetch.url.href).toBe('https://github.com/acme/demo.git/git-upload-pack');
		expect(push).toMatchObject({service: 'git-receive-pack', phase: 'pack', repository: 'acme/my.repo_1'});
		expect(pushRefs.phase).toBe('refs');
		expect([refs, fetch, push, pushRefs].map((request) => gitAction(request.service))).toEqual(['read', 'read', 'push', 'push']);
	});

	test('Git LFS is refused, saying it isn’t supported yet', () => {
		const lfs = gitRequest('POST', '/acme/demo.git/info/lfs/objects/batch', GIT);
		const locks = gitRequest('GET', '/acme/demo.git/info/lfs/locks', GIT);

		expect(lfs.unwrapErr()).toEqual({message: expect.stringContaining('Git LFS isn’t supported'), service: null, phase: 'refs'});
		expect(locks.unwrapErr().message).toContain('Git LFS');
	});

	test('anything else of git’s is refused: dumb HTTP, other services, the wrong method, extra query', () => {
		const refused = [
			gitRequest('GET', '/acme/demo.git/info/refs', GIT),
			gitRequest('GET', '/acme/demo.git/info/refs?service=git-upload-archive', GIT),
			gitRequest('GET', '/acme/demo.git/HEAD', GIT),
			gitRequest('GET', '/acme/demo.git/objects/info/packs', GIT),
			gitRequest('POST', '/acme/demo.git/info/refs?service=git-upload-pack', GIT),
			gitRequest('GET', '/acme/demo.git/git-upload-pack', GIT),
			gitRequest('POST', '/acme/demo.git/git-upload-pack?x=1', GIT),
			gitRequest('GET', '/acme/demo.git/info/refs?service=git-upload-pack&x=1', GIT),
		];

		for (const request of refused) {
			expect(request.isErr()).toBe(true);
		}
		// Where the request is a service's, it is answered as that service, which git shows.
		expect(refused[4]?.unwrapErr()).toMatchObject({service: 'git-upload-pack', phase: 'refs'});
		expect(refused[5]?.unwrapErr()).toMatchObject({service: 'git-upload-pack', phase: 'pack'});
	});

	test('no path trick names another repository or another host', () => {
		const tricks = [
			'//evil.example.com/acme/demo.git/git-upload-pack',
			'/acme/../evil/demo.git/git-upload-pack',
			'/acme/%2e%2e/demo.git/git-upload-pack',
			'/acme%2Fother/demo.git/git-upload-pack',
			'/acme/demo%2F..%2Fother.git/git-upload-pack',
			'/acme/../../git-upload-pack',
			'/acme/./git-upload-pack',
			'/acme/../git-upload-pack',
			'/@evil.example.com/demo.git/git-upload-pack',
			'/acme\\evil/demo.git/git-upload-pack',
			'/acme/demo.git/extra/git-upload-pack',
		];

		for (const path of tricks) {
			expect({path, refused: gitRequest('POST', path, GIT).isErr()}).toEqual({path, refused: true});
		}
	});
});

describe('API requests', () => {
	test('a path goes to the API as it is, with its query, naming the repository where it is one', () => {
		const repo = apiRequest('/repos/acme/demo/pulls?state=open&per_page=5', API);
		const user = apiRequest('/user', API);

		expect(repo?.url.href).toBe('https://api.github.com/repos/acme/demo/pulls?state=open&per_page=5');
		expect(repo).toMatchObject({path: '/repos/acme/demo/pulls', repository: 'acme/demo'});
		expect(user).toMatchObject({path: '/user', repository: null});
	});

	test('no path trick reaches another host, or another path than the one checked', () => {
		const tricks = ['//evil.example.com/x', '/repos/../user', '/repos/%2e%2e/user', '/repos/acme%2fdemo', '/repos/acme%5Cdemo', '/repos//acme', '/', '', '/a\\b', '/./user', '/x#y'];

		for (const path of tricks) {
			expect({path, request: apiRequest(path, API)}).toEqual({path, request: null});
		}
		// `@` in a path is only a path.
		expect(apiRequest('/@evil.example.com/x', API)?.url.origin).toBe(API);
	});

	test('upstreamUrl keeps to its origin and its path', () => {
		expect(upstreamUrl(API, '/a/b', '?c=d')?.href).toBe('https://api.github.com/a/b?c=d');
		expect(upstreamUrl(API, '//evil.example.com', '')).toBeNull();
		expect(upstreamUrl(API, '/a/../b', '')).toBeNull();
		expect(upstreamUrl(API, 'evil', '')).toBeNull();
		expect(upstreamUrl('http://localhost:1234', '/user', '')?.href).toBe('http://localhost:1234/user');
	});

	test('GET and HEAD read; every other method writes', () => {
		expect(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(apiAction)).toEqual(['read', 'read', 'write', 'write', 'write', 'write', 'write']);
		expect(isGraphql('POST', '/graphql')).toBe(true);
		expect(isGraphql('GET', '/graphql')).toBe(false);
		expect(isGraphql('POST', '/graphql/x')).toBe(false);
	});
});

describe('GraphQL', () => {
	test('a query reads, named or anonymous, shorthand too', () => {
		expect(graphqlAction(graphql('query Viewer { viewer { login } }'))).toEqual({action: 'read', operation: {type: 'query', name: 'Viewer'}});
		expect(graphqlAction(graphql('query { viewer { login } }'))).toEqual({action: 'read', operation: {type: 'query', name: null}});
		expect(graphqlAction(graphql('{ viewer { login } }'))).toEqual({action: 'read', operation: {type: 'query', name: null}});
	});

	test('a mutation writes', () => {
		const body = graphql('mutation CreatePullRequest($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }');

		expect(graphqlAction(body)).toEqual({action: 'write', operation: {type: 'mutation', name: 'CreatePullRequest'}});
	});

	test('with a query and a mutation in one document, operationName says which runs', () => {
		const document = 'query Read { viewer { login } } mutation Write { addStar(input: {starrableId: "x"}) { clientMutationId } }';

		expect(graphqlAction(graphql(document, 'Read'))).toEqual({action: 'read', operation: {type: 'query', name: 'Read'}});
		expect(graphqlAction(graphql(document, 'Write'))).toEqual({action: 'write', operation: {type: 'mutation', name: 'Write'}});
		// Without it, or naming none of them, it is a write.
		expect(graphqlAction(graphql(document)).action).toBe('write');
		expect(graphqlAction(graphql(document, null)).action).toBe('write');
		expect(graphqlAction(graphql(document, 'Other')).action).toBe('write');
	});

	test('"mutation" in a string, a block string or a comment is no mutation', () => {
		const document = `# mutation Evil { deleteRepository }
query Search($q: String = "mutation { x }") {
  search(query: "mutation \\" mutation", type: ISSUE, first: 1) { issueCount }
  a: repository(owner: """mutation""", name: "x") { id }
}`;

		expect(graphqlAction(graphql(document))).toEqual({action: 'read', operation: {type: 'query', name: 'Search'}});
	});

	test('fragments are no operation, and variables’ object defaults are no selection', () => {
		const document = 'fragment Repo on Repository { name } query Q($f: Filter = {a: {b: 1}}) @cached(ttl: 1) { viewer { repositories(first: 1) { nodes { ...Repo } } } }';

		expect(operationRun(document, null)).toEqual({type: 'query', name: 'Q'});
	});

	test('a body that isn’t a GraphQL request, or a document that can’t be read, is a write', () => {
		const garbage = [
			Buffer.from('not json'),
			Buffer.from('{"query": 1}'),
			Buffer.from('[]'),
			graphql(''),
			graphql('query { unclosed '),
			graphql('query "x'),
			graphql('type Query { a: Int }'),
			graphql('query Q { a } ; mutation M { b }'),
		];

		for (const body of garbage) {
			expect(graphqlAction(body).action).toBe('write');
		}
	});

	test('a subscription is a write, when in doubt', () => {
		expect(graphqlAction(graphql('subscription S { x }')).action).toBe('write');
	});
});

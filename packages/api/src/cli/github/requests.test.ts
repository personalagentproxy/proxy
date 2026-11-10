import {describe, expect, test} from 'bun:test';

import {apiRequest, gitAction, gitRequest, isGraphql, upstreamUrl} from './requests';

const GIT = 'https://github.com';
const API = 'https://api.github.com';

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
		expect(repo).toMatchObject({path: '/repos/acme/demo/pulls', segments: ['repos', 'acme', 'demo', 'pulls'], repository: 'acme/demo'});
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

	test('a POST to /graphql is GraphQL', () => {
		expect(isGraphql('POST', '/graphql')).toBe(true);
		expect(isGraphql('GET', '/graphql')).toBe(false);
		expect(isGraphql('POST', '/graphql/x')).toBe(false);
	});
});

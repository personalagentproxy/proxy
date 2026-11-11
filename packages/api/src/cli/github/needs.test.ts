import {describe, expect, test} from 'bun:test';

import {operationRun} from './graphql';
import {bodyTarget, graphqlNeed, needsDefaultBranch, pushActions, pushTargets, refTarget, restNeed} from './needs';

function graphql(query: string, operationName?: string | null): Buffer {
	return Buffer.from(JSON.stringify(operationName === undefined ? {query} : {query, operationName}));
}

// The path's segments, as apiRequest gives them.
function rest(method: string, path: string) {
	return restNeed(method, path.split('/').slice(1));
}

describe('REST', () => {
	test('GET and HEAD read, whatever the path', () => {
		expect(rest('GET', '/repos/acme/demo/pulls/1/merge')).toEqual({kind: 'actions', actions: ['read']});
		expect(rest('HEAD', '/user')).toEqual({kind: 'actions', actions: ['read']});
	});

	test('merging a pull request, or a branch into another, needs Merge', () => {
		expect(rest('PUT', '/repos/acme/demo/pulls/7/merge')).toEqual({kind: 'actions', actions: ['merge']});
		expect(rest('POST', '/repos/acme/demo/merges')).toEqual({kind: 'actions', actions: ['merge']});
	});

	test('pull requests and issues, their comments, reviews, labels and assignees need Contribute', () => {
		const paths = [
			['POST', '/repos/acme/demo/pulls'],
			['PATCH', '/repos/acme/demo/pulls/7'],
			['POST', '/repos/acme/demo/pulls/7/reviews'],
			['POST', '/repos/acme/demo/pulls/7/requested_reviewers'],
			['PATCH', '/repos/acme/demo/pulls/comments/3'],
			['POST', '/repos/acme/demo/issues'],
			['POST', '/repos/acme/demo/issues/7/comments'],
			['POST', '/repos/acme/demo/issues/7/labels'],
			['DELETE', '/repos/acme/demo/issues/comments/3/reactions/1'],
			['POST', '/repos/acme/demo/commits/abc/comments'],
		];

		for (const [method = '', path = ''] of paths) {
			expect({path, need: rest(method, path)}).toEqual({path, need: {kind: 'actions', actions: ['contribute']}});
		}
	});

	test('writing git’s objects, or a pull request’s branch, needs Push', () => {
		expect(rest('POST', '/repos/acme/demo/git/commits')).toEqual({kind: 'actions', actions: ['push']});
		expect(rest('POST', '/repos/acme/demo/git/blobs')).toEqual({kind: 'actions', actions: ['push']});
		expect(rest('PUT', '/repos/acme/demo/pulls/7/update-branch')).toEqual({kind: 'actions', actions: ['push']});
	});

	test('moving a ref is a push to it, a branch by its name, read as GitHub reads the path', () => {
		expect(rest('PATCH', '/repos/acme/demo/git/refs/heads/main')).toEqual({kind: 'push', targets: [{kind: 'branch', name: 'main'}]});
		expect(rest('DELETE', '/repos/acme/demo/git/refs/heads/feature/login')).toEqual({kind: 'push', targets: [{kind: 'branch', name: 'feature/login'}]});
		expect(rest('PATCH', '/repos/acme/demo/git/refs/heads/ma%69n')).toEqual({kind: 'push', targets: [{kind: 'branch', name: 'main'}]});
		expect(rest('DELETE', '/repos/acme/demo/git/refs/tags/v1')).toEqual({kind: 'push', targets: [{kind: 'other'}]});
		expect(rest('POST', '/repos/acme/demo/branches/main/rename')).toEqual({kind: 'push', targets: [{kind: 'branch', name: 'main'}]});
		expect(rest('PATCH', '/repos/acme/demo/git/refs/heads/%E0%A4%A')).toEqual({kind: 'actions', actions: ['manage']});
	});

	test('a write naming its branch in its body is read for it', () => {
		expect(rest('PUT', '/repos/acme/demo/contents/docs/a.md')).toEqual({kind: 'pushBody', field: 'branch'});
		expect(rest('DELETE', '/repos/acme/demo/contents/a.md')).toEqual({kind: 'pushBody', field: 'branch'});
		expect(rest('POST', '/repos/acme/demo/git/refs')).toEqual({kind: 'pushBody', field: 'ref'});
		expect(rest('POST', '/repos/acme/demo/merge-upstream')).toEqual({kind: 'pushBody', field: 'branch'});
	});

	test('anything else needs Manage: settings, the repository itself, releases, workflows, and paths elsewhere', () => {
		const paths = [
			['PATCH', '/repos/acme/demo'],
			['DELETE', '/repos/acme/demo'],
			['POST', '/repos/acme/demo/releases'],
			['POST', '/repos/acme/demo/actions/workflows/ci.yml/dispatches'],
			['PUT', '/repos/acme/demo/branches/main/protection'],
			['POST', '/repos/acme/demo/forks'],
			['POST', '/repos/acme/demo/labels'],
			['PUT', '/repositories/42/contents/a.md'],
			['POST', '/user/repos'],
			['POST', '/gists'],
		];

		for (const [method = '', path = ''] of paths) {
			expect({path, need: rest(method, path)}).toEqual({path, need: {kind: 'actions', actions: ['manage']}});
		}
	});
});

describe('refs and branches', () => {
	test('a ref, as git or GitHub’s API writes it', () => {
		expect(refTarget('refs/heads/main')).toEqual({kind: 'branch', name: 'main'});
		expect(refTarget('heads/fix/login')).toEqual({kind: 'branch', name: 'fix/login'});
		expect(refTarget('refs/tags/v1.2')).toEqual({kind: 'other'});
		expect(refTarget('refs/heads/')).toEqual({kind: 'other'});
	});

	test('the branch a body names; none, or a body that can’t be read, is the default branch', () => {
		const json = (value: object) => Buffer.from(JSON.stringify(value));

		expect(bodyTarget(json({message: 'm', content: 'eA==', branch: 'docs'}), 'branch')).toEqual({kind: 'branch', name: 'docs'});
		expect(bodyTarget(json({branch: 'refs/heads/main'}), 'branch')).toEqual({kind: 'branch', name: 'main'});
		expect(bodyTarget(json({message: 'm', content: 'eA=='}), 'branch')).toEqual({kind: 'default'});
		expect(bodyTarget(json({branch: ''}), 'branch')).toEqual({kind: 'default'});
		expect(bodyTarget(Buffer.from('not json'), 'branch')).toEqual({kind: 'default'});
		expect(bodyTarget(null, 'branch')).toEqual({kind: 'default'});
		expect(bodyTarget(json({ref: 'refs/heads/fix', sha: 'a'}), 'ref')).toEqual({kind: 'branch', name: 'fix'});
		expect(bodyTarget(json({ref: 'refs/tags/v1', sha: 'a'}), 'ref')).toEqual({kind: 'other'});
	});

	test('a git push’s refs; where the peek didn’t reach them all, the default branch too', () => {
		const refs = [
			{ref: 'refs/heads/fix-login', deleted: false},
			{ref: 'refs/tags/v1', deleted: false},
		];

		expect(pushTargets(refs, true)).toEqual([{kind: 'branch', name: 'fix-login'}, {kind: 'other'}]);
		expect(pushTargets(refs, false)).toContainEqual({kind: 'default'});
	});

	test('a push needs Push to the default branch where it reaches it, or could', () => {
		const fix = {kind: 'branch', name: 'fix-login'} as const;
		const main = {kind: 'branch', name: 'main'} as const;

		expect(pushActions([fix, {kind: 'other'}], 'main')).toEqual(['push']);
		expect(pushActions([fix, main], 'main')).toEqual(['push', 'pushDefault']);
		expect(pushActions([{kind: 'default'}], null)).toEqual(['push', 'pushDefault']);
		expect(pushActions([{kind: 'other'}], null)).toEqual(['push']);
		expect(pushActions([], null)).toEqual(['push']);
	});

	test('GitHub is asked for the default branch only where a branch named could be it', () => {
		expect(needsDefaultBranch([{kind: 'branch', name: 'fix'}])).toBe(true);
		expect(needsDefaultBranch([{kind: 'other'}])).toBe(false);
		expect(needsDefaultBranch([{kind: 'branch', name: 'fix'}, {kind: 'default'}])).toBe(false);
	});
});

describe('GraphQL', () => {
	test('a query reads, named or anonymous, shorthand too', () => {
		expect(graphqlNeed(graphql('query Viewer { viewer { login } }'))).toEqual({actions: ['read'], operation: {type: 'query', name: 'Viewer'}});
		expect(graphqlNeed(graphql('query { viewer { login } }'))).toEqual({actions: ['read'], operation: {type: 'query', name: null}});
		expect(graphqlNeed(graphql('{ viewer { login } }'))).toEqual({actions: ['read'], operation: {type: 'query', name: null}});
	});

	test('a mutation needs what its root fields do, by their names, never the operation’s', () => {
		const create = graphql('mutation CreatePullRequest($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }');
		const merge = graphql('mutation PullRequestMerge($input: MergePullRequestInput!) { mergePullRequest(input: $input) { clientMutationId } }');
		const disguised = graphql('mutation AddComment($input: MergePullRequestInput!) { comment: mergePullRequest(input: $input) { clientMutationId } }');
		const auto = graphql('mutation { enablePullRequestAutoMerge(input: {pullRequestId: "PR_1"}) { clientMutationId } }');

		expect(graphqlNeed(create)).toEqual({actions: ['contribute'], operation: {type: 'mutation', name: 'CreatePullRequest'}});
		expect(graphqlNeed(merge).actions).toEqual(['merge']);
		expect(graphqlNeed(disguised).actions).toEqual(['merge']);
		expect(graphqlNeed(auto).actions).toEqual(['merge']);
	});

	test('a mutation of several fields needs each of theirs; one unknown needs Manage', () => {
		const both = graphql('mutation { addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }');
		const unknown = graphql('mutation { addComment(input: {subjectId: "I_1", body: "x"}) { clientMutationId } deleteRepository(input: {repositoryId: "R_1"}) { clientMutationId } }');

		expect(graphqlNeed(both).actions).toEqual(['contribute', 'merge']);
		expect(graphqlNeed(unknown).actions).toEqual(['contribute', 'manage']);
	});

	test('moving a ref by its node id could be the default branch’s', () => {
		const update = graphql('mutation { updateRef(input: {refId: "REF_1", oid: "abc"}) { clientMutationId } }');
		const commit = graphql('mutation C($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }');

		expect(graphqlNeed(update).actions).toEqual(['pushDefault']);
		expect(graphqlNeed(commit).actions).toEqual(['pushDefault']);
	});

	test('fields at the root through fragments, inline or spread, count; a spread of none the document has needs Manage', () => {
		const spread = graphql('fragment M on Mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } } mutation { ...M }');
		const inline = graphql('mutation { ... on Mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } } }');
		const missing = graphql('mutation { ...Nowhere }');

		expect(graphqlNeed(spread).actions).toEqual(['merge']);
		expect(graphqlNeed(inline).actions).toEqual(['merge']);
		expect(graphqlNeed(missing).actions).toEqual(['manage']);
	});

	test('with a query and a mutation in one document, operationName says which runs', () => {
		const document = 'query Read { viewer { login } } mutation Write { addStar(input: {starrableId: "x"}) { clientMutationId } }';

		expect(graphqlNeed(graphql(document, 'Read'))).toEqual({actions: ['read'], operation: {type: 'query', name: 'Read'}});
		expect(graphqlNeed(graphql(document, 'Write'))).toEqual({actions: ['manage'], operation: {type: 'mutation', name: 'Write'}});
		// Without it, or naming none of them, it needs Manage.
		expect(graphqlNeed(graphql(document)).actions).toEqual(['manage']);
		expect(graphqlNeed(graphql(document, null)).actions).toEqual(['manage']);
		expect(graphqlNeed(graphql(document, 'Other')).actions).toEqual(['manage']);
	});

	test('"mutation" in a string, a block string or a comment is no mutation', () => {
		const document = `# mutation Evil { deleteRepository }
query Search($q: String = "mutation { x }") {
  search(query: "mutation \\" mutation", type: ISSUE, first: 1) { issueCount }
  a: repository(owner: """mutation""", name: "x") { id }
}`;

		expect(graphqlNeed(graphql(document))).toEqual({actions: ['read'], operation: {type: 'query', name: 'Search'}});
	});

	test('fragments are no operation, and variables’ object defaults are no selection', () => {
		const document = 'fragment Repo on Repository { name } query Q($f: Filter = {a: {b: 1}}) @cached(ttl: 1) { viewer { repositories(first: 1) { nodes { ...Repo } } } }';

		expect(operationRun(document, null)).toEqual({type: 'query', name: 'Q', fields: ['viewer']});
	});

	test('a body that isn’t a GraphQL request, or a document that can’t be read, needs Manage', () => {
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
			expect(graphqlNeed(body).actions).toEqual(['manage']);
		}
	});

	test('a subscription needs Manage, when in doubt', () => {
		expect(graphqlNeed(graphql('subscription S { x }')).actions).toEqual(['manage']);
	});
});

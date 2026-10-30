import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const findSources = mock();

mock.module('./sources', () => ({
	findSources,
	summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id}),
	withCapability: (sources: Array<{connector: object}>, capability: string) => sources.filter((source) => capability in source.connector),
}));
mock.module('../utils/user-org', () => ({
	requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}),
}));

const {rankFiles, handleFindFilesRoute} = await import('./files');

function found(id: string, kind: string, matched: 'name' | 'content', modified: string) {
	return {id, name: id, kind, owner: '', modified, link: null, matched};
}

function request(query: Record<string, string>) {
	return {user: {userId: 'user-1'}, query} as never;
}

beforeEach(() => {
	findSources.mockReset();
});

describe('rankFiles', () => {
	test('puts files of the kind said first, then those named so, then the most recently changed', () => {
		const files = [
			found('new-sheet', 'Spreadsheet', 'name', '2026-10-12T00:00:00Z'),
			found('old-doc', 'Document', 'name', '2026-01-01T00:00:00Z'),
			found('mentions-it', 'Document', 'content', '2026-10-14T00:00:00Z'),
			found('newer-sheet', 'Spreadsheet', 'name', '2026-10-13T00:00:00Z'),
		].map((file) => ({connectionId: 'g', ...file}));
		expect(rankFiles(files, 'Document').map((one) => one.id)).toEqual(['old-doc', 'mentions-it', 'newer-sheet', 'new-sheet']);
		expect(rankFiles(files, null).map((one) => one.id)).toEqual(['newer-sheet', 'new-sheet', 'old-doc', 'mentions-it']);
	});
});

describe('handleFindFilesRoute', () => {
	test('searches every file store that can be, the kind no filter but first, each file with its connection', async () => {
		const findFiles = mock(async () => Ok([found('Fragebogen Dr. Leichtle', 'Spreadsheet', 'name', '2026-10-12T00:00:00Z'), found('Leichtle notes', 'Document', 'content', '2026-10-01T00:00:00Z')]));
		findSources.mockResolvedValue(
			Ok([
				{connection: {id: 'google-1'}, connector: {findFiles}},
				// A collection of files that can't be searched for the widget.
				{connection: {id: 'other-1'}, connector: {}},
			]),
		);

		const answer = (await handleFindFilesRoute(request({words: ' leichtle ', kind: 'Document', owner: 'sam@example.com'}))).unwrap();
		expect(findSources).toHaveBeenCalledWith(expect.objectContaining({orgId: 'org-1', userId: 'user-1'}), 'files', 'list');
		expect(findFiles).toHaveBeenCalledWith(expect.anything(), {words: ['leichtle'], owner: 'sam@example.com'}, 8);
		expect(answer.sources.map((source) => source.connectionId)).toEqual(['google-1']);
		expect(answer.files.map((file) => [file.connectionId, file.name, file.kind, file.matched])).toEqual([
			['google-1', 'Leichtle notes', 'Document', 'content'],
			['google-1', 'Fragebogen Dr. Leichtle', 'Spreadsheet', 'name'],
		]);
	});
});

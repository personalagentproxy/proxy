import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const listFiles = mock();

mock.module('../connections/google/drive-api', () => ({listFiles, driveQuoted: (term: string) => `'${term}'`}));
mock.module('../connections/google/google-client', () => ({callGoogle: (_connection: unknown, call: (token: string) => unknown) => call('token')}));
mock.module('./sources', () => ({
	findSources: async () => Ok([{connection: {id: 'google-1'}, integration: {id: 'google'}}]),
	summarize: (source: {connection: {id: string}}) => ({connectionId: source.connection.id}),
}));
mock.module('../utils/user-org', () => ({
	requireViewer: async () => Ok({orgId: 'org-1', userId: 'user-1', slug: 'org-1', name: 'Workspace', role: 'owner', onboarded: true, experiments: []}),
	requireUserOrgId: async () => Ok('org-1'),
}));
// As the Drive connector reads a file's type.
mock.module('../records/google-files', () => ({kindOf: (mimeType: string) => (mimeType.endsWith('spreadsheet') ? 'Spreadsheet' : mimeType.endsWith('document') ? 'Document' : 'File')}));

const sheet = {id: 's1', name: 'Fragebogen Dr. Leichtle', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-12T00:00:00Z'};
const memo = {id: 'd1', name: 'Kickoff notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T00:00:00Z'};

function request(query: Record<string, string>) {
	return {user: {userId: 'user-1'}, query} as never;
}

beforeEach(() => {
	listFiles.mockReset();
});

describe('handleFindFilesRoute', () => {
	test('finds a spreadsheet asked for as a doc: the kind is no filter', async () => {
		listFiles.mockResolvedValue(Ok({items: [sheet], nextPage: null}));
		const {handleFindFilesRoute} = await import('./files');

		const found = (await handleFindFilesRoute(request({words: 'leichtle', kind: 'Document'}))).unwrap();
		expect(listFiles).toHaveBeenCalledTimes(1);
		expect(listFiles.mock.calls[0]?.[1]).toBe("name contains 'leichtle' and trashed = false");
		expect(found.files.map((file) => [file.name, file.kind, file.matched])).toEqual([['Fragebogen Dr. Leichtle', 'Spreadsheet', 'name']]);
	});

	test('searches inside the files where no name has the words', async () => {
		listFiles.mockResolvedValueOnce(Ok({items: [], nextPage: null})).mockResolvedValueOnce(Ok({items: [memo], nextPage: null}));
		const {handleFindFilesRoute} = await import('./files');

		const found = (await handleFindFilesRoute(request({words: 'leichtle'}))).unwrap();
		expect(listFiles.mock.calls[1]?.[1]).toBe("fullText contains 'leichtle' and trashed = false");
		expect(listFiles.mock.calls[1]?.[2]).not.toHaveProperty('orderBy');
		expect(found.files.map((file) => [file.name, file.matched])).toEqual([['Kickoff notes', 'content']]);
	});
});

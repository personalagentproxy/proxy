import {beforeEach, describe, expect, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

import {type FakeStore, fakeStore} from './fake-store';
import {type SdkSessionStore, sdkSessionStore} from './session-store';

const key = {projectKey: '-tmp-thread-1', sessionId: 'session-1'};
const user = {type: 'user', uuid: 'u1', message: {role: 'user', content: 'Find my invoices'}};
const assistant = {type: 'assistant', uuid: 'a1', message: {role: 'assistant', content: [{type: 'text', text: 'Looking.'}]}};
const summary = {type: 'summary', summary: 'Invoices', leafUuid: 'a1'};

let store: FakeStore;
let sessions: SdkSessionStore;

beforeEach(() => {
	store = fakeStore();
	sessions = sdkSessionStore(store);
});

describe('the SDK’s session store', () => {
	test('appends each entry as a line of JSON under the key, with its uuid where it has one', async () => {
		store.appendTranscript.mockResolvedValue(Ok(undefined));

		await sessions.append(key, [user, assistant, summary]);

		expect(store.appendTranscript).toHaveBeenCalledWith(key, [{uuid: 'u1', entry: JSON.stringify(user)}, {uuid: 'a1', entry: JSON.stringify(assistant)}, {entry: JSON.stringify(summary)}]);
	});

	test('loads the lines back as the entries they were, in order, dropping a line that isn’t one; null where there is no transcript', async () => {
		store.loadTranscript.mockResolvedValueOnce(Ok([JSON.stringify(user), 'not json', JSON.stringify({uuid: 'x'}), JSON.stringify(summary)])).mockResolvedValueOnce(Ok(null));

		expect(await sessions.load({...key, subpath: 'subagents/agent-1.jsonl'})).toEqual([user, summary]);
		expect(store.loadTranscript).toHaveBeenCalledWith({...key, subpath: 'subagents/agent-1.jsonl'});
		expect(await sessions.load(key)).toBeNull();
	});

	test('lists a session’s subpaths by the project and the session alone, and deletes by the key', async () => {
		store.listTranscriptSubkeys.mockResolvedValue(Ok(['subagents/agent-1.jsonl']));
		store.deleteTranscript.mockResolvedValue(Ok(undefined));

		expect(await sessions.listSubkeys({...key, subpath: 'ignored'})).toEqual(['subagents/agent-1.jsonl']);
		expect(store.listTranscriptSubkeys).toHaveBeenCalledWith(key);
		await sessions.delete(key);
		expect(store.deleteTranscript).toHaveBeenCalledWith(key);
	});

	test('rejects where the store failed, as the SDK expects, with the failure as the cause', async () => {
		const failure = ApiErr.dbError(new Error('down'));
		store.appendTranscript.mockResolvedValue(Err(failure));
		store.loadTranscript.mockResolvedValue(Err(failure));

		await expect(sessions.append(key, [user])).rejects.toMatchObject({message: 'The session store could not append to the transcript: db_error', cause: failure});
		await expect(sessions.load(key)).rejects.toMatchObject({cause: failure});
	});
});

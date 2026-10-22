import {describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const logProxyAction = mock(async (): Promise<unknown> => Ok(undefined));
const saveWriteTarget = mock(async (): Promise<unknown> => Ok(undefined));

mock.module('@proxy/db/audit', () => ({logProxyAction}));
mock.module('@proxy/db/write-target', () => ({saveWriteTarget}));

const source = {connection: {id: 'work', ownerUserId: 'user-1'}, collection: {id: 'events'}} as never;

describe('afterWrite', () => {
	test("logs the write as Personal Agent Proxy's, for the person who asked, and keeps where it went", async () => {
		const {afterWrite} = await import('./writes');

		await afterWrite({orgId: 'org-1', userId: 'user-1', source, action: 'create', title: 'Lunch', parent: 'team'});
		expect(logProxyAction).toHaveBeenCalledWith({orgId: 'org-1', connectionId: 'work', collectionId: 'events', action: 'create', recordTitle: 'Lunch', ownerUserId: 'user-1', userId: 'user-1'});
		expect(saveWriteTarget).toHaveBeenCalledWith({userId: 'user-1', collectionId: 'events', connectionId: 'work', parent: 'team'});
	});

	test('fails nothing when the log or the place written to cannot be kept', async () => {
		logProxyAction.mockResolvedValueOnce(Err(ApiErr.dbError(new Error('down'))));
		saveWriteTarget.mockResolvedValueOnce(Err(ApiErr.dbError(new Error('down'))));
		const {afterWrite} = await import('./writes');

		expect(await afterWrite({orgId: 'org-1', userId: 'user-1', source, action: 'sendNew', title: '', parent: null})).toBeUndefined();
	});
});

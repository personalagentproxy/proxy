import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

// The server's settings, which the blob store reads: none of them from a `.env`, which a checkout
// that only runs the tests has none of.
mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL: 'https://app.example.com', FILES_MAX_MB: 100}}));

// The agent's blobs, by id, as the blob store hands them over: found only for the agent that made them.
type Stored = {name: string | null; type: string | null; bytes: Buffer; agentId: string};
const blobs: Record<string, Stored> = {};
const opened: string[] = [];

const realBlobs = await import('../blobs/blobs');
mock.module('../blobs/blobs', () => ({
	...realBlobs,
	requireBlob: async (owner: {orgId: string; agentId: string}, id: string) => {
		const found = blobs[id];
		if (found === undefined || found.agentId !== owner.agentId) {
			return Err(ApiErr.notFound('blob', id, `There is no blob ${id} of yours.`));
		}
		return Ok({id, name: found.name, type: found.type, size: found.bytes.length});
	},
}));

const realContent = await import('../native/files/content');
mock.module('../native/files/content', () => ({
	...realContent,
	openContent: async (blob: {id: string}) => {
		opened.push(blob.id);
		return Ok(new Blob([new Uint8Array(blobs[blob.id]?.bytes ?? Buffer.from(''))]).stream());
	},
}));

const {attachedBlobs, attachmentOptions, MAX_ATTACHED_BYTES, requireAttachable} = await import('./email-attachments');

const connection = {
	id: 'mail-1',
	integrationId: 'email',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'alex@example.com',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [],
	credentialRejectedAt: null,
	credential: null,
};
const collection = {id: 'emails', name: 'Emails', singular: 'email', titleField: 'subject', writes: {}, fields: []};
const asAgent = {connection, collection, by: {agentId: 'agent-1', taskId: 'task-1'}};

beforeEach(() => {
	for (const id of Object.keys(blobs)) {
		delete blobs[id];
	}
	opened.length = 0;
	blobs.b1 = {name: 'offer.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF offer'), agentId: 'agent-1'};
	blobs.b2 = {name: null, type: 'image/png', bytes: Buffer.from('png'), agentId: 'agent-1'};
	blobs.b3 = {name: 'theirs.txt', type: null, bytes: Buffer.from('x'), agentId: 'agent-2'};
});

describe('attachedBlobs', () => {
	test('attaches nothing where nothing is named, whoever writes the email', async () => {
		expect((await attachedBlobs({connection, collection, by: {userId: 'user-1'}}, '')).unwrap()).toEqual([]);
		expect((await attachedBlobs({connection, collection}, undefined)).unwrap()).toEqual([]);
		expect((await attachedBlobs(asAgent, ' , ')).unwrap()).toEqual([]);
	});

	test('attaches the agent’s blobs it names, each once, in the order written, under their own names and types', async () => {
		const attached = (await attachedBlobs(asAgent, 'b2, b1,b2\nb1')).unwrap();

		expect(attached).toEqual([
			{filename: 'attachment-1', contentType: 'image/png', content: Buffer.from('png')},
			{filename: 'offer.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF offer')},
		]);
	});

	test('refuses a blob that isn’t the agent’s, and a member, who has none', async () => {
		expect((await attachedBlobs(asAgent, 'b1, b3')).unwrapErr()).toMatchObject({kind: 'not_found', message: 'There is no blob b3 of yours.'});
		expect((await attachedBlobs(asAgent, 'none')).unwrapErr().kind).toBe('not_found');
		expect((await attachedBlobs({connection, collection, by: {userId: 'user-1'}}, 'b1')).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: 'attach takes an agent’s blobs: only an agent attaches one',
		});
		expect(opened).toEqual([]);
	});

	test('refuses more than an email carries before reading any of it', async () => {
		blobs.big = {name: 'film.mov', type: null, bytes: Buffer.alloc(MAX_ATTACHED_BYTES), agentId: 'agent-1'};

		expect((await attachedBlobs(asAgent, 'big')).isOk()).toBe(true);
		opened.length = 0;
		expect((await attachedBlobs(asAgent, 'big, b1')).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: 'An email carries at most 25.0 MB of attachments, and these come to 25.0 MB: put the file in a drive and send its link instead.',
		});
		expect(opened).toEqual([]);
	});
});

describe('what is attached', () => {
	test('is refused past what an email carries, with what a draft has already counted', () => {
		const half = {content: Buffer.alloc(MAX_ATTACHED_BYTES / 2)};

		expect(requireAttachable([half, half]).isOk()).toBe(true);
		expect(requireAttachable([half, half, {content: Buffer.from('x')}]).unwrapErr().kind).toBe('validation_error');
	});

	test('goes on a message as files below it, and a picture its HTML shows in the text', () => {
		expect(attachmentOptions([])).toEqual({});
		expect(
			attachmentOptions([
				{filename: 'offer.pdf', contentType: 'application/pdf', content: Buffer.from('a')},
				{filename: 'logo.png', contentType: 'image/png', content: Buffer.from('b'), cid: 'logo@proxy'},
			]),
		).toEqual({
			attachments: [
				{filename: 'offer.pdf', contentType: 'application/pdf', content: Buffer.from('a')},
				{filename: 'logo.png', contentType: 'image/png', content: Buffer.from('b'), cid: 'logo@proxy', contentDisposition: 'inline'},
			],
		});
	});
});

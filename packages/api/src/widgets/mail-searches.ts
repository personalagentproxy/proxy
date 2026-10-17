import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {IntegrationId} from '@proxy/integrations';

import type {DataRecord} from '../records/connector';
import {findInboxEmails} from '../records/email-connector';
import type {EmailSearch} from '../records/email-search';
import {findGmailEmails} from '../records/google-emails';
import type {Source} from './sources';

/**
 * How an integration's mail is searched; a mail integration joins the widgets with one. It runs
 * several searches at once, as the People widget asks one per name, over one sign-in, and answers
 * the emails each found, in the order asked, and stops when `signal` says it was given up on. Its records have a list's values and `cc` beside
 * them, which the collection has no field for but the widgets find people in.
 */
export type MailSearch = (source: Source, searches: EmailSearch[], limit: number, signal: AbortSignal) => Promise<Result<DataRecord[][], ApiError>>;

const SEARCHES: Partial<Record<IntegrationId, MailSearch>> = {google: findGmailEmails, email: findInboxEmails};

/** The mailboxes among `sources` that can be searched, each with its search. */
export function searchable(sources: Source[]): Array<Source & {find: MailSearch}> {
	return sources.flatMap((source) => {
		const find = SEARCHES[source.integration.id];
		return find ? [{...source, find}] : [];
	});
}

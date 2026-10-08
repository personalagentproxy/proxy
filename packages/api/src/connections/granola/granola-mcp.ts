import {XMLParser} from 'fast-xml-parser';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, httpRequest, parseSchema} from '@proxy/utils';

import {mcpAuthError, type McpServer} from '../mcp/mcp-oauth';

/**
 * Granola's MCP server and what its tools answer. The tools answer in text made for models: a
 * sentence telling the model to treat what follows as data, then meetings as XML
 * (`<meetings_data><meeting id title date url>…`) or a transcript as JSON.
 */

const AUTH_BASE = 'https://mcp-auth.granola.ai';

export const GRANOLA: McpServer = {
	name: 'Granola',
	url: 'https://mcp.granola.ai/mcp',
	registerUrl: `${AUTH_BASE}/oauth2/register`,
	authorizeUrl: `${AUTH_BASE}/oauth2/authorize`,
	tokenUrl: `${AUTH_BASE}/oauth2/token`,
	scope: 'openid profile email offline_access',
};

const userInfoSchema = z.object({sub: z.string(), email: z.string().optional(), name: z.string().optional()});

/** The Granola account a token belongs to: its email, else its name, else Granola's id for it. */
export async function getGranolaAccount(accessToken: string): Promise<Result<string, ApiError>> {
	const info = await httpRequest(`${AUTH_BASE}/oauth2/userinfo`, {headers: {authorization: `Bearer ${accessToken}`}}, {schema: userInfoSchema, timeoutMs: 15_000});
	if (info.isErr()) {
		return Err(mcpAuthError(info.error));
	}
	return Ok(info.value.email?.toLowerCase() ?? info.value.name ?? info.value.sub);
}

export type GranolaMeeting = {
	id: string;
	title: string;
	// As Granola writes it, in the account's time zone: "Sep 22, 2026 11:00 AM PDT".
	date: string;
	// The day of `date`, `2026-09-22`, or null when Granola's date can't be read.
	day: string | null;
	url: string;
	// "Alex (note creator) from Acme <alex@acme.com>, Sam <sam@example.com>", as Granola writes it.
	participants: string;
	summary: string;
	privateNotes: string;
};

const xml = new XMLParser({
	ignoreAttributes: false,
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
	processEntities: true,
	isArray: (tagName) => tagName === 'meeting',
});

const meetingSchema = z.object({
	'@_id': z.string().min(1),
	'@_title': z.string().optional(),
	'@_date': z.string().optional(),
	'@_url': z.string().optional(),
	known_participants: z.string().optional(),
	summary: z.string().optional(),
	private_notes: z.string().optional(),
});

// `<meetings_data count="0" />` when there are none. Ids Granola doesn't know are listed apart, in
// `<not_found>`.
const meetingsResponseSchema = z.object({
	meetings_data: z.union([z.literal(''), z.object({meeting: z.array(meetingSchema).optional()})]),
});

// What `get_meetings` answers when it knows none of the ids: `{"meetings": [], "not_found": […]}`.
const noMeetingsSchema = z.object({meetings: z.array(z.never())});

const transcriptResponseSchema = z.object({transcript: z.string()});

// What follows the sentence Granola puts before its data: from the first `<` or `{`.
function dataOf(text: string): string {
	const start = text.search(/[<{]/);
	return start === -1 ? text : text.slice(start);
}

function parseXml(text: string): Result<unknown, ApiError> {
	if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
		return Err(ApiErr.providerUnreachable(new Error('Granola answered with an XML declaration')));
	}
	return Result.wrap((): unknown => xml.parse(`<granola_response>${text}</granola_response>`).granola_response).mapErr((cause) => ApiErr.providerUnreachable(cause));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The day of one of Granola's dates, "Sep 22, 2026 11:00 AM PDT", as `2026-09-22`; null when it can't be read. */
export function granolaDay(date: string): string | null {
	const match = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\b/.exec(date.trim());
	const month = MONTHS.indexOf(match?.[1] ?? '');
	if (!match || month === -1) {
		return null;
	}
	return `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2]?.padStart(2, '0')}`;
}

/** The meetings in a `list_meetings` or `get_meetings` answer, newest first as Granola sends them. */
export function parseGranolaMeetings(text: string): Result<GranolaMeeting[], ApiError> {
	const data = dataOf(text);
	if (data.startsWith('{')) {
		return Result.wrap((): unknown => JSON.parse(data))
			.mapErr((cause) => ApiErr.providerUnreachable(cause))
			.andThen((json) => parseSchema(noMeetingsSchema, json).mapErr((error) => ApiErr.providerUnreachable(error)))
			.map(() => []);
	}

	return Do<GranolaMeeting[], ApiError>(($) => {
		const document = $(parseXml(data));
		const parsed = $(parseSchema(meetingsResponseSchema, document).mapErr((error) => ApiErr.providerUnreachable(error)));
		const meetings = parsed.meetings_data === '' ? [] : (parsed.meetings_data.meeting ?? []);
		return meetings.map((meeting) => ({
			id: meeting['@_id'],
			title: meeting['@_title'] || 'Untitled meeting',
			date: meeting['@_date'] ?? '',
			day: granolaDay(meeting['@_date'] ?? ''),
			url: meeting['@_url'] ?? '',
			participants: meeting.known_participants ?? '',
			summary: meeting.summary ?? '',
			privateNotes: meeting.private_notes ?? '',
		}));
	});
}

/**
 * A `get_meeting_transcript` answer's transcript, out of the JSON Granola sends it in; empty when
 * Granola says in words that the meeting has none.
 */
export function parseGranolaTranscript(text: string): Result<string, ApiError> {
	const data = dataOf(text);
	if (!data.startsWith('{') && /\bno transcript\b/i.test(data)) {
		return Ok('');
	}
	return Result.wrap((): unknown => JSON.parse(data))
		.mapErr((cause) => ApiErr.providerUnreachable(cause))
		.andThen((json) => parseSchema(transcriptResponseSchema, json).mapErr((error) => ApiErr.providerUnreachable(error)))
		.map(({transcript}) => transcript.trim());
}

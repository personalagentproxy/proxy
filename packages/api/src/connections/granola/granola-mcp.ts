import {XMLParser} from 'fast-xml-parser';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, httpRequest, parseSchema} from '@proxy/utils';

import {GRANOLA_MCP_URL} from './granola-oauth';

/**
 * Granola's MCP server, called one tool at a time. The server keeps no session, so each call is a
 * single JSON-RPC `tools/call` with the access token, answered as JSON or as a one-event stream.
 * The tools answer in text made for models: a sentence telling the model to treat what follows as
 * data, then meetings as XML (`<meetings_data><meeting id title date url>…`) or a transcript as
 * JSON.
 */

const TIMEOUT_MS = 30_000;

const toolResponseSchema = z.object({
	result: z
		.object({
			content: z.array(z.object({type: z.string(), text: z.string().optional()})),
			isError: z.boolean().optional(),
		})
		.optional(),
	error: z.object({message: z.string()}).optional(),
});

// The last `data:` line of an event stream, or the body as it is when it is plain JSON.
function jsonRpcBody(body: string): string {
	const events = body
		.split('\n')
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice('data:'.length).trim());
	return events.at(-1) ?? body;
}

/**
 * Calls one of Granola's tools, its answer's text. A token Granola turns down is
 * `credentials_rejected`, so the caller can refresh it; a tool failing, such as on Granola's rate
 * limit, is Granola out of reach.
 */
export function callGranolaTool(accessToken: string, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const response = await httpRequest(
			GRANOLA_MCP_URL,
			{
				method: 'POST',
				headers: {authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream'},
				body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
			},
			{parse: 'text', timeoutMs: TIMEOUT_MS},
		);
		if (response.isErr() && response.error.kind === 'http' && (response.error.status === 401 || response.error.status === 403)) {
			return $(Err(ApiErr.credentialsRejected()));
		}

		const body = $(response.mapErr((error) => ApiErr.providerUnreachable(error)));
		const json = $(Result.wrap((): unknown => JSON.parse(jsonRpcBody(body))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		const message = $(parseSchema(toolResponseSchema, json).mapErr((error) => ApiErr.providerUnreachable(error)));
		if (message.error || !message.result) {
			return $(Err(ApiErr.providerUnreachable(new Error(`Granola's ${name} failed: ${message.error?.message ?? 'no result'}`))));
		}

		const text = message.result.content.map((block) => block.text ?? '').join('\n');
		if (message.result.isError) {
			return $(Err(ApiErr.providerUnreachable(new Error(`Granola's ${name} failed: ${text}`))));
		}
		return text;
	});
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

import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {parseGranolaMeetings, parseGranolaTranscript, type GranolaMeeting} from '../connections/granola/granola-mcp';
import {callGranolaToolFor} from '../connections/granola/granola-session';
import type {Connector, DataRecord, RecordTarget, RecordValues} from './connector';

/**
 * Granola's meeting notes, fetched live from its MCP server with the connection's tokens. Notes and
 * Transcripts are the same meetings, by Granola's meeting id: a note opens with its summary and the
 * owner's own notes, a transcript word for word. Granola's tools have no pages, so a page is 30
 * days of meetings, newest first, and the next page token the day before them. A page that finds
 * none looks back to when Granola started at once and shows the 30 days up to the newest meeting
 * there, so months without meetings are skipped and the list ends where they run out. Granola
 * only reads, so nothing is written.
 */

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Granola has no notes from before it started.
const FIRST_DAY = '2023-01-01';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Granola's meeting ids, and the note ids it takes for them too.
const MEETING_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|not_[a-zA-Z0-9]{14})$/i;

function dayOf(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

// The last day a page lists: the page token, else tomorrow, so no time zone leaves out today.
function lastDay(page: string | null): Result<string, ApiError> {
	if (page === null) {
		return Ok(dayOf(Date.now() + DAY_MS));
	}
	if (!DAY.test(page) || Number.isNaN(Date.parse(page))) {
		return Err(ApiErr.validationError('Not a page of Granola notes'));
	}
	return Ok(page);
}

function daysBefore(day: string, days: number): string {
	return dayOf(Date.parse(day) - days * DAY_MS);
}

function listMeetings(target: RecordTarget, start: string, end: string): Promise<Result<GranolaMeeting[], ApiError>> {
	return Do(async ($) => {
		const text = $(await callGranolaToolFor(target.connection, 'list_meetings', {time_range: 'custom', custom_start: start, custom_end: end}));
		return $(parseGranolaMeetings(text));
	});
}

// The 30 days of meetings ending at `end`, and the token of the 30 before them; or, when there are
// none, the 30 days up to the newest meeting before them.
function meetingsPage(target: RecordTarget, end: string): Promise<Result<{meetings: GranolaMeeting[]; nextPage: string | null}, ApiError>> {
	return Do(async ($) => {
		const start = daysBefore(end, WINDOW_DAYS - 1);
		const meetings = $(await listMeetings(target, start, end));
		if (meetings.length > 0) {
			return {meetings, nextPage: start > FIRST_DAY ? daysBefore(start, 1) : null};
		}
		if (start <= FIRST_DAY) {
			return {meetings, nextPage: null};
		}

		const older = $(await listMeetings(target, FIRST_DAY, daysBefore(start, 1)));
		const newest = older.map((meeting) => meeting.day).find((day) => day !== null);
		if (!newest) {
			return {meetings: older, nextPage: null};
		}
		const windowStart = daysBefore(newest, WINDOW_DAYS - 1);
		return {
			meetings: older.filter((meeting) => meeting.day === null || meeting.day >= windowStart),
			nextPage: windowStart > FIRST_DAY ? daysBefore(windowStart, 1) : null,
		};
	});
}

function summaryValues(meeting: GranolaMeeting): RecordValues {
	return {title: meeting.title, date: meeting.date};
}

function toRecord(meeting: GranolaMeeting, values: RecordValues): DataRecord {
	return {id: meeting.id, values, updatedAt: meeting.day ?? ''};
}

function getMeeting(target: RecordTarget, meetingId: string): Promise<Result<GranolaMeeting, ApiError>> {
	return Do(async ($) => {
		if (!MEETING_ID.test(meetingId)) {
			return $(Err(ApiErr.notFound('record', meetingId)));
		}
		const text = $(await callGranolaToolFor(target.connection, 'get_meetings', {meeting_ids: [meetingId]}));
		const meeting = $(parseGranolaMeetings(text)).find((candidate) => candidate.id === meetingId);
		if (!meeting) {
			return $(Err(ApiErr.notFound('record', meetingId)));
		}
		return meeting;
	});
}

function readOnly<T>(): Promise<Result<T, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Granola notes are read-only')));
}

export const granolaConnector: Connector = {
	list: (target, query) =>
		Do(async ($) => {
			const page = $(await meetingsPage(target, $(lastDay(query.page))));
			return {records: page.meetings.map((meeting) => toRecord(meeting, summaryValues(meeting))), nextPage: page.nextPage};
		}),
	get: (target, recordId) =>
		Do(async ($) => {
			const meeting = $(await getMeeting(target, recordId));
			if (target.collection.id === 'transcripts') {
				const text = $(await callGranolaToolFor(target.connection, 'get_meeting_transcript', {meeting_id: recordId}));
				return toRecord(meeting, {...summaryValues(meeting), transcript: $(parseGranolaTranscript(text))});
			}
			return toRecord(meeting, {...summaryValues(meeting), attendees: meeting.participants, link: meeting.url, summary: meeting.summary, privateNotes: meeting.privateNotes});
		}),
	create: () => readOnly(),
	update: () => readOnly(),
	remove: () => readOnly(),
};

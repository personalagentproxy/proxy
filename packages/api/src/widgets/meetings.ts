import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import type {IntegrationId} from '@proxy/integrations';

import type {GranolaMeeting} from '../connections/granola/granola-mcp';
import {listGranolaMeetings} from '../records/granola-connector';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import {requireAskExperiment} from './ask-experiment';
import {eachSource, type Failure} from './each-source';
import {findSources, summarize, type Source, type SourceSummary} from './sources';

/**
 * Meetings for the Ask widget: every meeting notetaker connected, its meetings between two days,
 * those with every person named, the ones whose title or summary has the most of the words first,
 * then the newest. Granola has no search, so its meetings for the days are listed and picked from
 * here.
 */

/** Days as 2026-10-14, both included; people by name or address; words of the title or topic. */
export type MeetingSearch = {from: string; to: string; people: string[]; words: string[]};

export type FoundMeeting = {
	connectionId: string;
	id: string;
	title: string;
	// As the notetaker writes it: "Sep 22, 2026 11:00 AM PDT".
	date: string;
	participants: string;
	link: string | null;
};

/** How an integration's meetings are listed; a meeting notetaker joins the widget with one. */
type MeetingsList = (source: Source, search: MeetingSearch) => Promise<Result<FoundMeeting[], ApiError>>;

// What the widget offers at most, across every notetaker.
const LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

// The days searched when none are said: the last month, and tomorrow, so no time zone leaves out today.
const DEFAULT_DAYS = 30;

function wordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word !== '');
}

/** Whether a person, by name or address, is among the participants: each word of theirs begins one of the participants'. */
export function isParticipant(participants: string, person: string): boolean {
	const theirs = wordsOf(participants);
	return wordsOf(person).every((word) => theirs.some((one) => one.startsWith(word)));
}

/** A meeting as it was listed, with its summary to rank it by. */
type Listed = {meeting: FoundMeeting; summary: string};

/** The meetings to offer: with every person named, the most words of the title and summary first, then as they came, newest first. */
export function rankMeetings(listed: Listed[], search: MeetingSearch): FoundMeeting[] {
	const wanted = search.words.flatMap(wordsOf);
	const score = ({meeting, summary}: Listed) => {
		const theirs = new Set(wordsOf(`${meeting.title} ${summary}`));
		return wanted.filter((word) => theirs.has(word)).length;
	};
	return listed
		.filter(({meeting}) => search.people.every((person) => isParticipant(meeting.participants, person)))
		.map((one) => ({meeting: one.meeting, score: score(one)}))
		.sort((a, b) => b.score - a.score)
		.slice(0, LIMIT)
		.map(({meeting}) => meeting);
}

function listed(connectionId: string, meeting: GranolaMeeting): Listed {
	return {
		meeting: {connectionId, id: meeting.id, title: meeting.title, date: meeting.date, participants: meeting.participants, link: meeting.url || null},
		summary: meeting.summary,
	};
}

// Granola is asked to the day after, as it may end before the last day it is given, and its
// meetings outside the days are left out after.
const listGranola: MeetingsList = (source, search) =>
	Do(async ($) => {
		const meetings = $(await listGranolaMeetings(source, search.from, dayOf(Date.parse(search.to) + DAY_MS)));
		return rankMeetings(
			meetings.filter((meeting) => meeting.day === null || (meeting.day >= search.from && meeting.day <= search.to)).map((meeting) => listed(source.connection.id, meeting)),
			search,
		);
	});

const LISTS: Partial<Record<IntegrationId, MeetingsList>> = {granola: listGranola};

function dayOf(time: number): string {
	return new Date(time).toISOString().slice(0, 10);
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const many = z
	.union([z.string(), z.array(z.string())])
	.optional()
	.transform((value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]))
	.transform((values) =>
		values
			.map((one) => one.trim().slice(0, 100))
			.filter((one) => one !== '')
			.slice(0, 10),
	);

const querySchema = z.object({from: day.optional(), to: day.optional(), with: many, words: many});

export type FoundMeetings = {sources: SourceSummary[]; meetings: FoundMeeting[]; failed: Failure[]};

/** `GET /api/widgets/meetings?from=…&to=…&with=…&words=…`: the meetings each notetaker finds. */
export function handleFindMeetingsRoute(request: AuthenticatedRequest): Promise<Result<FoundMeetings, ApiError>> {
	return Do(async ($) => {
		$(requireAskExperiment(request));
		const query = $(parseSchema(querySchema, request.query));
		const to = query.to ?? dayOf(Date.now() + DAY_MS);
		const search: MeetingSearch = {from: query.from ?? dayOf(Date.parse(to) - DEFAULT_DAYS * DAY_MS), to, people: query.with, words: query.words};
		const orgId = $(await requireUserOrgId(request));
		const sources = $(await findSources(orgId, 'notes', 'list')).flatMap((source) => {
			const list = LISTS[source.integration.id];
			return list ? [{...source, list}] : [];
		});
		const {found, failed} = await eachSource(sources, (source) => source.list(source, search));
		// Each notetaker's best first, then the next's: one person seldom has two.
		const meetings = found.flatMap(({value}) => value).slice(0, LIMIT);
		return {sources: sources.map(summarize), meetings, failed};
	});
}

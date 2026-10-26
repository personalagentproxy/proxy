import {findIntegration} from '@proxy/integrations';

import type {GoogleCredential} from './google-oauth';

/**
 * Which of Google's scopes allow each action. Google's consent screen lets a person untick some of
 * what a sign-in asks for, and a connection made before an action joined the catalog lacks its
 * scope, so an action is only available where the sign-in granted the scopes allowing it.
 */

const scope = (name: string): string => `https://www.googleapis.com/auth/${name}`;

// Each of an action's ways in is the scopes that together allow it; any one way is enough.

// Gmail's reading, labelling, Trash and drafts all take `gmail.modify`; sending takes it too, or
// `gmail.send` alone.
const GMAIL = [[scope('gmail.modify')]];

// Calendar's events take `calendar.events`, and the calendars holding them, listed at the top and
// read for their names and time zones, `calendar.calendarlist.readonly`.
const CALENDAR = [[scope('calendar.events'), scope('calendar.calendarlist.readonly')]];

// Who is free takes `calendar.events.freebusy`, and the primary calendar's time zone, which times
// without an offset are on, `calendar.calendarlist.readonly`.
const AVAILABILITY = [[scope('calendar.events.freebusy'), scope('calendar.calendarlist.readonly')]];

// Drive's export and uploads and the Sheets API take `drive` for reading and writing alike, so it
// alone covers every file action; the Docs, Sheets and Slides scopes would add nothing to it.
const DRIVE = [[scope('drive')]];

const CONTACTS = [[scope('contacts')]];

// The people Gmail keeps under Other contacts are read with a scope of their own, only ever read.
const OTHER_CONTACTS = [[scope('contacts.other.readonly')]];

const TASKS = [[scope('tasks')]];

/** Every scope a sign-in asks for beyond the account's address, in the order Google shows them. */
export const PRODUCT_SCOPES = [
	scope('gmail.modify'),
	scope('gmail.send'),
	scope('calendar.events'),
	scope('calendar.calendarlist.readonly'),
	scope('calendar.events.freebusy'),
	scope('drive'),
	scope('contacts'),
	scope('contacts.other.readonly'),
	scope('tasks'),
];

const ACTION_SCOPES: Partial<Record<string, string[][]>> = {
	readEmails: GMAIL,
	markEmails: GMAIL,
	flagEmails: GMAIL,
	archiveEmails: GMAIL,
	writeEmails: GMAIL,
	trashEmails: GMAIL,
	sendEmails: [[scope('gmail.send')], [scope('gmail.modify')]],
	readEvents: CALENDAR,
	readAvailability: AVAILABILITY,
	writeEvents: CALENDAR,
	respondEvents: CALENDAR,
	inviteGuests: CALENDAR,
	readFiles: DRIVE,
	createFiles: DRIVE,
	editFiles: DRIVE,
	trashFiles: DRIVE,
	readContacts: CONTACTS,
	writeContacts: CONTACTS,
	readOtherContacts: OTHER_CONTACTS,
	readTasks: TASKS,
	writeTasks: TASKS,
};

/** The actions a Google sign-in didn't cover, in the catalog's order; one the map leaves out is never covered. */
export function unavailableGoogleActions(credential: GoogleCredential): string[] {
	const actions = findIntegration('google')?.actions ?? [];
	const covered = (ways: string[][]) => ways.some((needed) => needed.every((one) => credential.scopes.includes(one)));
	return actions.filter((action) => !covered(ACTION_SCOPES[action.id] ?? [])).map((action) => action.id);
}

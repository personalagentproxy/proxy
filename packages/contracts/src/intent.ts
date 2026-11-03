import {z} from 'zod';

import {type Experiment, hasExperiment} from '@proxy/utils';
import {TRANSACTION_CATEGORIES} from '@proxy/utils/transaction-categories';
import {UNITS} from '@proxy/utils/units';

/**
 * The widgets the home page shows for what a person types, Sana's way: Jev picks the one that fits,
 * and a small, fast LLM fills in its fields from the text (`packages/api/src/intent/`). Most are
 * meant for one kind of data: Calendar, Contacts, Gmail or Drive, or a bank; Math and Convert units
 * are worked out in the web app; Ask reads one meeting, file, email, page or issue and answers from
 * it. A widget behind an experiment is offered only to an organization with it on.
 */

type FieldOf<Id extends string> = {
	id: Id;
	name: string;
	/**
	 * What the LLM is told the field holds. Worded by trying them: "without 's" keeps "jacky's
	 * email address" to Jacky, and "without any date or time" keeps "last week" out of a search.
	 */
	hint: string;
	/** A list, as a meeting's attendees are, one item each. */
	many?: true;
	/**
	 * Search terms, every one of which is to be found, each a list of words any of which will do:
	 * "my flight to sfo" is (flight, itinerary, e-ticket, booking) and (SFO, San Francisco). Each
	 * is answered as its words joined by " | ".
	 */
	terms?: true;
	/** The values it can hold, which the model picks one of, or none: a unit's id. */
	options?: readonly string[];
};

type WidgetOf<Id extends string, FieldId extends string> = {
	id: Id;
	name: string;
	/** What Jev reads to tell the widgets apart, and the LLM reads to know what it fills in. */
	description: string;
	fields: ReadonlyArray<FieldOf<FieldId>>;
	/** The experiment an organization needs on to be offered it. */
	experiment?: Experiment;
};

// Times aren't fields: the web app reads them from the whole text, which no field holds whole. A
// change to an event says two, when it is and when it moves to, so those are fields of their own.
// The units Convert units knows, each as the model is told of it: `mi` (mile).
const UNIT_LIST = UNITS.map((unit) => `${unit.id} (${unit.name})`).join(', ');

// The kinds of spending Transactions knows, each as the model is told of it: `FOOD_AND_DRINK`
// (restaurants, groceries, coffee, bars, delivery, eating out).
const CATEGORY_LIST = TRANSACTION_CATEGORIES.map(
	(category) => `${category.id} (${category.examples})`,
).join(', ');

// Each widget's id and its fields' as literals, for `WidgetId` and `FieldId`.
const LIST = [
	{
		id: 'new_event',
		name: 'New event',
		description: 'Schedule a meeting, call or calendar invite with people at a time',
		fields: [
			{
				id: 'attendees',
				name: 'Attendees',
				hint: 'each person to invite, one per item, as written (a name or an email address); never the person typing',
				many: true,
			},
			{id: 'location', name: 'Location', hint: 'where it takes place, as written, or null'},
			{
				id: 'title',
				name: 'Title',
				hint: 'the event\'s name: one it was given, else a short one from what it is ("Lunch"); null when it is only a meeting, call or event',
			},
		],
	},
	{
		id: 'change_event',
		name: 'Change event',
		description:
			'Change an event already in the calendar: move it to another time, rename it, change where it is, or invite people to it or take them off it',
		fields: [
			{
				id: 'changeWith',
				name: 'With',
				hint: 'each person the event to change is with, to find it by, as written without \'s ("my 1:1 with arne" is arne); never the person typing, nor someone being invited or taken off',
				many: true,
			},
			{
				id: 'changeEvent',
				name: 'Event',
				hint: 'what the event to change is, as written, without the people or any day or time ("standup", "lunch"); null when it is only a meeting, call or event',
			},
			{
				id: 'changeFrom',
				name: 'When',
				hint: 'when the event to change is now, as written ("friday", "tomorrow\'s"); null when not said',
			},
			{
				id: 'changeTo',
				name: 'New time',
				hint: 'the time it moves to, as written ("thursday at 3", "10am", "an hour later"); null when its time stays',
			},
			{
				id: 'invite',
				name: 'Invite',
				hint: 'each person to invite to it, one per item, as written (a name or an email address)',
				many: true,
			},
			{
				id: 'uninvite',
				name: 'Take off',
				hint: 'each person to take off it, one per item, as written (a name or an email address)',
				many: true,
			},
			{id: 'newTitle', name: 'New title', hint: 'its new name when it is renamed, else null'},
			{id: 'newLocation', name: 'New location', hint: 'where it moves to, as written, else null'},
		],
	},
	{
		id: 'show_calendar',
		name: 'Calendar',
		description:
			'See what is on the calendar on a day, or find when a meeting or event is: what is on today or tomorrow, when the person is meeting someone, when their next dentist appointment is',
		fields: [
			{
				id: 'meetingWith',
				name: 'With',
				hint: "each person the event is with, one per item, as written (a name or an email address) without 's; never the person typing",
				many: true,
			},
			{
				id: 'eventName',
				name: 'Event',
				hint: 'what the event is, as written, without the people or any day or time ("dentist", "standup", "flight to SFO"); null when it is only a meeting, call or event, or only a day is asked about',
			},
		],
	},
	{
		id: 'find_person',
		name: 'Person',
		description: 'Look up who someone is, or their email address or phone number',
		fields: [
			{
				id: 'person',
				name: 'Person',
				hint: "the person's name or address alone, without 's or what is asked about them",
			},
		],
	},
	{
		id: 'write_email',
		name: 'Write email',
		description: 'Write, draft or send a new email to someone, rather than a reply to one received',
		fields: [
			{
				id: 'to',
				name: 'To',
				hint: 'each recipient, one per item, as written (a name or an email address)',
				many: true,
			},
			{
				id: 'subject',
				name: 'Subject',
				hint: 'a short subject from what the email is about, or null',
			},
			{
				id: 'body',
				name: 'Message',
				hint: 'the email itself, written for the person in their voice from what they ask it to say, as short as they ask, greeting every recipient once by first name ("Hi Jon and Jacky,"), without a sign-off or placeholders such as [Your name]; null when they say nothing of what it says',
			},
		],
	},
	{
		id: 'reply_email',
		name: 'Reply to email',
		description:
			'Reply or respond to an email or thread already received, or answer what someone wrote ("reply to sam\'s email about the invoice saying it\'s paid", "respond to the offsite thread that I\'m in", "answer jacky\'s email about friday with a yes")',
		fields: [
			{
				id: 'from',
				name: 'From',
				hint: 'who sent the email to reply to, by name or address, as written without \'s (a person or a company); null for one described rather than named, such as "my landlord"',
			},
			{
				id: 'about',
				name: 'About',
				hint: 'what to search the email to reply to for, without the sender, any date or time, or what the reply says: a list of things it is about, all of which must be in it, each thing a list of other words for that same one thing, any of which will do; "reply to sam about the invoice saying it\'s paid" is [["invoice", "bill"]], "respond to the offsite thread" is [["offsite", "off-site", "retreat"]]; empty when only the sender or a time is said',
				terms: true,
			},
			{
				id: 'body',
				name: 'Reply',
				hint: 'the reply itself, written for the person in their voice from what they ask it to say, as short as they ask, greeting the sender once by first name ("Hi Sam,") when they are named, without a sign-off, a subject or placeholders such as [Your name]; null when they say nothing of what it says',
			},
		],
	},
	{
		id: 'find_email',
		name: 'Find email',
		description: 'Find, search for or open emails already received or sent',
		fields: [
			{
				id: 'from',
				name: 'From',
				hint: 'who sent it by name or address, as written (a person or a company); null for one described rather than named, such as "my landlord"',
			},
			{
				id: 'about',
				name: 'About',
				hint: 'what to search its text for, without the sender or any date or time: a list of things it is about, all of which must be in it, each thing a list of other words for that same one thing, any of which will do; "my flight to sfo" is [["flight", "itinerary", "e-ticket", "booking"], ["SFO", "San Francisco"]], "the signed nda" is [["NDA", "non-disclosure"], ["signed", "signature"]]; empty when only the sender or a time is said',
				terms: true,
			},
		],
	},
	{
		id: 'find_file',
		name: 'Find file',
		description: 'Find or open a file, document, spreadsheet or presentation in Drive',
		fields: [
			{
				id: 'name',
				name: 'Name',
				hint: "the file's name, or the words in it, as written, without its owner or 's",
			},
			{
				id: 'owner',
				name: 'Owner',
				hint: "who made, owns or shared it, as written without 's, or null",
			},
		],
	},
	{
		id: 'ask',
		name: 'Ask',
		experiment: 'ask',
		description:
			'Ask what one meeting, call, document, page, email or issue says: what was talked about or decided with someone, what a document or an email says about something, where an issue stands, or a summary of any of them ("what did I talk to sam about on monday", "what does the pricing doc say about discounts", "what did my landlord\'s email say about the deposit", "what\'s the status of the checkout bug", "summarize the board deck")',
		fields: [
			{
				id: 'askIn',
				name: 'In',
				hint: '"meetings" when it asks about a meeting or call, what was talked about, said or decided with someone, or a meeting\'s notes or transcript; "documents" when it asks about a document, file, spreadsheet, presentation, page or wiki, in Drive or Notion; "emails" when it asks about an email, or what someone wrote or sent by email; "issues" when it asks about an issue, ticket, bug or task in Linear; null when none is clear',
				options: ['meetings', 'documents', 'emails', 'issues'],
			},
			{
				id: 'askWith',
				name: 'With',
				hint: "each person the meeting was with, who sent the email, or who wrote or owns the document, one per item, as written without 's; never the person typing",
				many: true,
			},
			{
				id: 'askAbout',
				name: 'About',
				hint: 'the meeting\'s, document\'s, email\'s or issue\'s name or topic, to find it by, as written, without the people, any date or time, words such as "meeting", "call", "doc", "file", "email" or "issue", or what is asked of it ("what does the pricing doc say about discounts" is "pricing", "summarize our weekly sync" is "weekly sync", "what did my landlord\'s email say about the deposit" is "deposit"); null when it is found by its people or time alone',
			},
		],
	},
	{
		id: 'calculate',
		name: 'Math',
		description:
			'Work out arithmetic or math: sums, percentages, tips, splitting a bill, powers, roots',
		fields: [
			{
				id: 'expression',
				name: 'Calculation',
				hint: 'the calculation as one expression of numbers, + - * / ^, parentheses, % for percent and pi, sqrt(), ln(), log(), sin() and the like; "18% tip on $86.40" is "18% * 86.40", "split 120 four ways" is "120 / 4"',
			},
		],
	},
	{
		id: 'convert_units',
		name: 'Convert units',
		description:
			'Convert a quantity from one unit to another: length, weight, volume, temperature, speed, area, time, data, energy, or money from one currency to another',
		fields: [
			{
				id: 'amount',
				name: 'Amount',
				hint: 'the number to convert, in digits ("five" is "5"); "1" when only units are said',
			},
			{
				id: 'fromUnit',
				name: 'From',
				hint: `the unit it is in, one of: ${UNIT_LIST}`,
				options: UNITS.map((unit) => unit.id),
			},
			{
				id: 'toUnit',
				name: 'To',
				hint: 'the unit to convert it to, of the same list; null when not said',
				options: UNITS.map((unit) => unit.id),
			},
		],
	},
	{
		id: 'show_balances',
		name: 'Balances',
		description:
			'See the balance of a bank account, card or loan, or how much money the person has or owes in all',
		fields: [
			{
				id: 'balanceAccount',
				name: 'Account',
				hint: 'the account asked about, as written without my ("checking", "amex", "savings", "credit card"); null for every account',
			},
		],
	},
	{
		id: 'find_transactions',
		name: 'Transactions',
		description:
			'Find bank or card transactions, charges, payments and deposits, or add up what was spent or received: at a merchant, of a kind, on an account, over some days ("how much did I spend on restaurants last month", "find the uber charge", "when did I last get paid")',
		fields: [
			{
				id: 'merchant',
				name: 'Merchant',
				hint: 'the business or person paid or paying, as written ("uber", "netflix", "my landlord"), without any day or time; never a kind of thing bought ("groceries", "rent", "coffee"), which is category, nor an account or card of the person\'s own ("my sapphire", "checking"), which is transactionAccount; null when no one is named',
			},
			{
				id: 'category',
				name: 'Category',
				hint: `the kind of spending or income asked about, one of: ${CATEGORY_LIST}; null when none is said`,
				options: TRANSACTION_CATEGORIES.map((category) => category.id),
			},
			{
				id: 'flow',
				name: 'Flow',
				hint: '"in" for money coming in (deposits, paychecks, refunds, income), "out" for money spent or paid; null when either or not said',
				options: ['in', 'out'],
			},
			{
				id: 'transactionAccount',
				name: 'Account',
				hint: 'the account the transactions are on, as written without my ("checking", "amex"); null when not said',
			},
		],
	},
] as const satisfies ReadonlyArray<WidgetOf<string, string>>;

/** A widget's id, as the api picks it and the web app shows it. */
export type WidgetId = (typeof LIST)[number]['id'];

/** A field's id, of any widget. */
export type FieldId = (typeof LIST)[number]['fields'][number]['id'];

export type WidgetField = FieldOf<FieldId>;

export type Widget = WidgetOf<WidgetId, FieldId>;

export const WIDGETS: readonly Widget[] = LIST;

// The ids written out rather than read from the widgets, so that the web app, which answers by
// them alone, takes none of what the widgets tell the model into the browser. `contracts.test.ts`
// checks each list against the widgets.

/** Every widget's id. */
export const WIDGET_IDS = [
	'new_event',
	'change_event',
	'show_calendar',
	'find_person',
	'write_email',
	'reply_email',
	'find_email',
	'find_file',
	'ask',
	'calculate',
	'convert_units',
	'show_balances',
	'find_transactions',
] as const satisfies readonly WidgetId[];

/** Every field's id, of any widget, each once. */
export const FIELD_IDS = [
	'attendees',
	'location',
	'title',
	'changeWith',
	'changeEvent',
	'changeFrom',
	'changeTo',
	'invite',
	'uninvite',
	'newTitle',
	'newLocation',
	'meetingWith',
	'eventName',
	'person',
	'to',
	'subject',
	'body',
	'from',
	'about',
	'name',
	'owner',
	'askIn',
	'askWith',
	'askAbout',
	'expression',
	'amount',
	'fromUnit',
	'toUnit',
	'balanceAccount',
	'merchant',
	'category',
	'flow',
	'transactionAccount',
] as const satisfies readonly FieldId[];

/** The widgets offered to an organization: every one not behind an experiment, and those behind one it has on. */
export function offeredWidgets(holder: {experiments: Experiment[]}): Widget[] {
	return WIDGETS.filter((widget) => !widget.experiment || hasExperiment(holder, widget.experiment));
}

/** The answer when what was asked is whole and none of the widgets does it. */
export const NO_WIDGET = 'none';

/**
 * The answer when the text is cut off or says too little to tell yet, as it is half-way through
 * typing: the home page waits for more rather than saying nothing fits.
 */
export const INCOMPLETE = 'incomplete';

const text = z.string().trim().min(1).max(500);

/** `POST /api/orgs/:org/intent`: what was typed, to pick a widget for. */
export const pickBodySchema = z.object({text});

export type PickBody = z.input<typeof pickBodySchema>;

/** `POST /api/orgs/:org/intent/fields`: what was typed, and the widget picked for it, to fill in. */
export const fillBodySchema = z.object({text, widget: z.string().min(1)});

/** The widget's id is typed here, though the api answers an id it doesn't offer as not found. */
export type FillBody = z.input<typeof fillBodySchema> & {widget: WidgetId};

/** The widget Jev picked. */
export const pickedSchema = z.object({
	/**
	 * The widget's id, `none` when what was asked is whole and none does it, or `incomplete` when
	 * too little was typed to tell yet.
	 */
	widget: z.enum([...WIDGET_IDS, NO_WIDGET, INCOMPLETE]),
	/** How long Jev took. */
	ms: z.number(),
});

export type Picked = z.infer<typeof pickedSchema>;

/** A field of the picked widget and what fills it: one value, or each of a list's. */
export const filledFieldSchema = z.object({
	id: z.enum(FIELD_IDS),
	name: z.string(),
	values: z.array(z.string()),
});

export type FilledField = z.infer<typeof filledFieldSchema>;

/** The picked widget's fields, filled in. */
export const filledSchema = z.object({
	fields: z.array(filledFieldSchema),
	/** How long the model took. */
	ms: z.number(),
});

export type Filled = z.infer<typeof filledSchema>;

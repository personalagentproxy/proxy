import {type Experiment, hasExperiment} from '@proxy/utils';
import {TRANSACTION_CATEGORIES} from '@proxy/utils/transaction-categories';
import {UNITS} from '@proxy/utils/units';

/**
 * The widgets the home page shows for what a person types, Sana's way: Jev picks the one that fits,
 * and a small, fast LLM fills in its fields from the text. Most are meant for one kind of data:
 * Calendar, Contacts, Gmail or Drive, or a bank; Math and Convert units are worked out in the web
 * app. A widget behind an experiment is offered only to an organization with it on.
 */

export type WidgetField = {
	id: string;
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
	options?: string[];
};

export type Widget = {
	id: string;
	name: string;
	/** What Jev reads to tell the widgets apart, and the LLM reads to know what it fills in. */
	description: string;
	fields: WidgetField[];
	/** The experiment an organization needs on to be offered it, as banks are behind `plaid`. */
	experiment?: Experiment;
};

// Times aren't fields: the web app reads them from the whole text, which no field holds whole. A
// change to an event says two, when it is and when it moves to, so those are fields of their own.
// The units Convert units knows, each as the model is told of it: `mi` (mile).
const UNIT_LIST = UNITS.map((unit) => `${unit.id} (${unit.name})`).join(', ');

// The kinds of spending Transactions knows, each as the model is told of it: `FOOD_AND_DRINK`
// (restaurants, groceries, coffee, bars, delivery, eating out).
const CATEGORY_LIST = TRANSACTION_CATEGORIES.map((category) => `${category.id} (${category.examples})`).join(', ');

export const WIDGETS: Widget[] = [
	{
		id: 'new_event',
		name: 'New event',
		description: 'Schedule a meeting, call or calendar invite with people at a time',
		fields: [
			{id: 'attendees', name: 'Attendees', hint: 'each person to invite, one per item, as written (a name or an email address); never the person typing', many: true},
			{id: 'location', name: 'Location', hint: 'where it takes place, as written, or null'},
			{id: 'title', name: 'Title', hint: 'the event\'s name: one it was given, else a short one from what it is ("Lunch"); null when it is only a meeting, call or event'},
		],
	},
	{
		id: 'change_event',
		name: 'Change event',
		description: 'Change an event already in the calendar: move it to another time, rename it, change where it is, or invite people to it or take them off it',
		fields: [
			{
				id: 'changeWith',
				name: 'With',
				hint: 'each person the event to change is with, to find it by, as written without \'s ("my 1:1 with arne" is arne); never the person typing, nor someone being invited or taken off',
				many: true,
			},
			{id: 'changeEvent', name: 'Event', hint: 'what the event to change is, as written, without the people or any day or time ("standup", "lunch"); null when it is only a meeting, call or event'},
			{id: 'changeFrom', name: 'When', hint: 'when the event to change is now, as written ("friday", "tomorrow\'s"); null when not said'},
			{id: 'changeTo', name: 'New time', hint: 'the time it moves to, as written ("thursday at 3", "10am", "an hour later"); null when its time stays'},
			{id: 'invite', name: 'Invite', hint: 'each person to invite to it, one per item, as written (a name or an email address)', many: true},
			{id: 'uninvite', name: 'Take off', hint: 'each person to take off it, one per item, as written (a name or an email address)', many: true},
			{id: 'newTitle', name: 'New title', hint: 'its new name when it is renamed, else null'},
			{id: 'newLocation', name: 'New location', hint: 'where it moves to, as written, else null'},
		],
	},
	{
		id: 'show_calendar',
		name: 'Calendar',
		description: 'See what is on the calendar on a day, or find when a meeting or event is: what is on today or tomorrow, when the person is meeting someone, when their next dentist appointment is',
		fields: [
			{id: 'meetingWith', name: 'With', hint: "each person the event is with, one per item, as written (a name or an email address) without 's; never the person typing", many: true},
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
		fields: [{id: 'person', name: 'Person', hint: "the person's name or address alone, without 's or what is asked about them"}],
	},
	{
		id: 'write_email',
		name: 'Write email',
		description: 'Write, draft or send a new email to someone',
		fields: [
			{id: 'to', name: 'To', hint: 'each recipient, one per item, as written (a name or an email address)', many: true},
			{id: 'subject', name: 'Subject', hint: 'a short subject from what the email is about, or null'},
			{
				id: 'body',
				name: 'Message',
				hint: 'the email itself, written for the person in their voice from what they ask it to say, as short as they ask, greeting every recipient once by first name ("Hi Jon and Jacky,"), without a sign-off or placeholders such as [Your name]; null when they say nothing of what it says',
			},
		],
	},
	{
		id: 'find_email',
		name: 'Find email',
		description: 'Find, search for or open emails already received or sent',
		fields: [
			{id: 'from', name: 'From', hint: 'who sent it by name or address, as written (a person or a company); null for one described rather than named, such as "my landlord"'},
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
			{id: 'name', name: 'Name', hint: "the file's name, or the words in it, as written, without its owner or 's"},
			{id: 'owner', name: 'Owner', hint: "who made, owns or shared it, as written without 's, or null"},
		],
	},
	{
		id: 'calculate',
		name: 'Math',
		description: 'Work out arithmetic or math: sums, percentages, tips, splitting a bill, powers, roots',
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
		description: 'Convert a quantity from one unit to another: length, weight, volume, temperature, speed, area, time, data, energy, or money from one currency to another',
		fields: [
			{id: 'amount', name: 'Amount', hint: 'the number to convert, in digits ("five" is "5"); "1" when only units are said'},
			{id: 'fromUnit', name: 'From', hint: `the unit it is in, one of: ${UNIT_LIST}`, options: UNITS.map((unit) => unit.id)},
			{id: 'toUnit', name: 'To', hint: 'the unit to convert it to, of the same list; null when not said', options: UNITS.map((unit) => unit.id)},
		],
	},
	{
		id: 'show_balances',
		name: 'Balances',
		experiment: 'plaid',
		description: 'See the balance of a bank account, card or loan, or how much money the person has or owes in all',
		fields: [{id: 'balanceAccount', name: 'Account', hint: 'the account asked about, as written without my ("checking", "amex", "savings", "credit card"); null for every account'}],
	},
	{
		id: 'find_transactions',
		name: 'Transactions',
		experiment: 'plaid',
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
			{id: 'flow', name: 'Flow', hint: '"in" for money coming in (deposits, paychecks, refunds, income), "out" for money spent or paid; null when either or not said', options: ['in', 'out']},
			{id: 'transactionAccount', name: 'Account', hint: 'the account the transactions are on, as written without my ("checking", "amex"); null when not said'},
		],
	},
];

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

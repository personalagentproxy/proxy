import {UNITS} from '@proxy/utils/units';

/**
 * The widgets the home page shows for what a person types, Sana's way: a small, fast LLM picks the
 * one that fits and fills in its fields from the text. Most are meant for one kind of data:
 * Calendar, Contacts, Gmail or Drive; Math and Convert units are worked out in the web app. Field ids are unique across widgets, as the LLM answers
 * every widget's fields in one object.
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
	/** What the LLM reads to tell the widgets apart. */
	description: string;
	fields: WidgetField[];
};

// Times aren't fields: the web app reads them from the whole text, which no field holds whole.
// The units Convert units knows, each as the model is told of it: `mi` (mile).
const UNIT_LIST = UNITS.map((unit) => `${unit.id} (${unit.name})`).join(', ');

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
];

/** The answer when none of the widgets fits, or the text says too little yet. */
export const NO_WIDGET = 'none';

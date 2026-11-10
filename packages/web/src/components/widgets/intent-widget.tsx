import type {ReactNode} from 'react';
import {NO_WIDGET, type WidgetId} from '@proxy/contracts/intent';
import type {Intent} from '@/client/intent-client';
import {Skeleton} from '@proxy/ui/components/skeleton';
import {AskWidget} from '@/components/widgets/ask-widget';
import {BalancesWidget} from '@/components/widgets/balances-widget';
import {CalendarWidget} from '@/components/widgets/calendar-widget';
import {ConvertWidget} from '@/components/widgets/convert-widget';
import {EditEventWidget} from '@/components/widgets/edit-event-widget';
import {EventWidget} from '@/components/widgets/event-widget';
import {FindEmailWidget} from '@/components/widgets/find-email-widget';
import {FindFileWidget} from '@/components/widgets/find-file-widget';
import {MathWidget} from '@/components/widgets/math-widget';
import {NewAgentWidget} from '@/components/widgets/new-agent-widget';
import {PersonWidget} from '@/components/widgets/person-widget';
import {ReplyEmailWidget} from '@/components/widgets/reply-email-widget';
import {TransactionsWidget} from '@/components/widgets/transactions-widget';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {WriteEmailWidget} from '@/components/widgets/write-email-widget';
import type {BarAction} from '@/hooks/use-bar-action';

type Props = {
	intent: Intent;
	// What was classified: times are read from it whole, and a file search falls back on its words.
	typed: string;
	// When it was classified, which the widgets' times are read against.
	now: Date;
	// Types something else into the input, for a widget that leads to another: Person's Find emails.
	onAsk: (text: string) => void;
	// For a widget with a main button, which Enter in the bar's input presses (enter-button.tsx).
	bar: BarAction;
};

// Each widget, filled with its fields, by its id: a widget the api offers that the web app has no
// way to show fails typecheck, as does an id the api doesn't have.
const VIEWS: Record<WidgetId, (props: Props) => ReactNode> = {
	new_event: ({intent, typed, now, bar}) => (
		<EventWidget intent={intent} typed={typed} now={now} bar={bar} />
	),
	change_event: ({intent, typed, now, bar}) => (
		<EditEventWidget intent={intent} typed={typed} now={now} bar={bar} />
	),
	show_calendar: ({intent, typed, now}) => (
		<CalendarWidget intent={intent} typed={typed} now={now} />
	),
	find_person: ({intent, onAsk, bar}) => <PersonWidget intent={intent} onAsk={onAsk} bar={bar} />,
	write_email: ({intent, typed, bar}) => (
		<WriteEmailWidget intent={intent} typed={typed} bar={bar} />
	),
	reply_email: ({intent, typed, now, bar}) => (
		<ReplyEmailWidget intent={intent} typed={typed} now={now} bar={bar} />
	),
	find_email: ({intent, typed, now}) => <FindEmailWidget intent={intent} typed={typed} now={now} />,
	find_file: ({intent, typed}) => <FindFileWidget intent={intent} typed={typed} />,
	ask: ({intent, typed, now}) => <AskWidget intent={intent} typed={typed} now={now} />,
	calculate: ({intent}) => <MathWidget intent={intent} />,
	convert_units: ({intent}) => <ConvertWidget intent={intent} />,
	show_balances: ({intent}) => <BalancesWidget intent={intent} />,
	find_transactions: ({intent, typed, now}) => (
		<TransactionsWidget intent={intent} typed={typed} now={now} />
	),
	new_agent: ({intent, typed, bar}) => <NewAgentWidget intent={intent} typed={typed} bar={bar} />,
};

// The widget the api picked, filled with its fields; nothing for `none`.
export function IntentWidget(props: Props) {
	const {widget} = props.intent;
	if (widget === NO_WIDGET) {
		return null;
	}
	return VIEWS[widget](props);
}

// What each widget is called, as it says it is, for its frame while its fields are filled in.
const NAMES: Record<WidgetId, string> = {
	new_event: 'New event',
	change_event: 'Change event',
	show_calendar: 'Calendar',
	find_person: 'Person',
	write_email: 'Write email',
	reply_email: 'Reply to email',
	find_email: 'Find email',
	find_file: 'Find file',
	ask: 'Ask',
	calculate: 'Math',
	convert_units: 'Convert units',
	show_balances: 'Balances',
	find_transactions: 'Transactions',
	new_agent: 'New agent',
};

// The widget the api picked, as soon as it is picked: lines in its place, until its fields are filled in.
export function FillingWidget({widget}: {widget: Intent['widget']}) {
	if (widget === NO_WIDGET) {
		return null;
	}
	return (
		<WidgetFrame name={NAMES[widget]}>
			<p className="sr-only">Filling in…</p>
			<div aria-hidden className="flex flex-col gap-3">
				<Skeleton className="h-4 w-2/3" />
				<Skeleton className="h-4 w-1/2" />
			</div>
		</WidgetFrame>
	);
}

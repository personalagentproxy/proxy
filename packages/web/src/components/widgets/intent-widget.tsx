import {
	ArrowRightLeftIcon,
	CalculatorIcon,
	CalendarDaysIcon,
	CalendarIcon,
	FileSearchIcon,
	InboxIcon,
	LandmarkIcon,
	MailIcon,
	MessageCircleQuestionMarkIcon,
	ReceiptTextIcon,
	ReplyIcon,
	UserRoundIcon,
	type LucideIcon,
} from 'lucide-react';
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
import {PersonWidget} from '@/components/widgets/person-widget';
import {ReplyEmailWidget} from '@/components/widgets/reply-email-widget';
import {TransactionsWidget} from '@/components/widgets/transactions-widget';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {WriteEmailWidget} from '@/components/widgets/write-email-widget';

type Props = {
	intent: Intent;
	// What was classified: times are read from it whole, and a file search falls back on its words.
	typed: string;
	// When it was classified, which the widgets' times are read against.
	now: Date;
	// Types something else into the input, for a widget that leads to another: Person's Find emails.
	onAsk: (text: string) => void;
};

// Each widget, filled with its fields, by its id: a widget the api offers that the web app has no
// way to show fails typecheck, as does an id the api doesn't have.
const VIEWS: Record<WidgetId, (props: Props) => ReactNode> = {
	new_event: ({intent, typed, now}) => <EventWidget intent={intent} typed={typed} now={now} />,
	change_event: ({intent, typed, now}) => (
		<EditEventWidget intent={intent} typed={typed} now={now} />
	),
	show_calendar: ({intent, typed, now}) => (
		<CalendarWidget intent={intent} typed={typed} now={now} />
	),
	find_person: ({intent, onAsk}) => <PersonWidget intent={intent} onAsk={onAsk} />,
	write_email: ({intent, typed}) => <WriteEmailWidget intent={intent} typed={typed} />,
	reply_email: ({intent, typed, now}) => (
		<ReplyEmailWidget intent={intent} typed={typed} now={now} />
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
};

// The widget the api picked, filled with its fields; nothing for `none`.
export function IntentWidget(props: Props) {
	const {widget} = props.intent;
	if (widget === NO_WIDGET) {
		return null;
	}
	return VIEWS[widget](props);
}

// What each widget is called and its icon, as it shows them, for its frame while its fields are
// filled in.
const FRAMES: Record<WidgetId, {icon: LucideIcon; name: string}> = {
	new_event: {icon: CalendarIcon, name: 'New event'},
	change_event: {icon: CalendarIcon, name: 'Change event'},
	show_calendar: {icon: CalendarDaysIcon, name: 'Calendar'},
	find_person: {icon: UserRoundIcon, name: 'Person'},
	write_email: {icon: MailIcon, name: 'Write email'},
	reply_email: {icon: ReplyIcon, name: 'Reply to email'},
	find_email: {icon: InboxIcon, name: 'Find email'},
	find_file: {icon: FileSearchIcon, name: 'Find file'},
	ask: {icon: MessageCircleQuestionMarkIcon, name: 'Ask'},
	calculate: {icon: CalculatorIcon, name: 'Math'},
	convert_units: {icon: ArrowRightLeftIcon, name: 'Convert units'},
	show_balances: {icon: LandmarkIcon, name: 'Balances'},
	find_transactions: {icon: ReceiptTextIcon, name: 'Transactions'},
};

// The widget the api picked, as soon as it is picked: its frame, until its fields are filled in.
export function FillingWidget({widget}: {widget: Intent['widget']}) {
	if (widget === NO_WIDGET) {
		return null;
	}
	const frame = FRAMES[widget];
	return (
		<WidgetFrame icon={frame.icon} name={frame.name}>
			<p className="sr-only">Filling in…</p>
			<div aria-hidden className="flex flex-col gap-3">
				<Skeleton className="h-4 w-2/3" />
				<Skeleton className="h-4 w-1/2" />
			</div>
		</WidgetFrame>
	);
}

import {
	ArrowRightLeftIcon,
	CalculatorIcon,
	CalendarDaysIcon,
	CalendarIcon,
	FileSearchIcon,
	InboxIcon,
	LandmarkIcon,
	MailIcon,
	ReceiptTextIcon,
	UserRoundIcon,
	type LucideIcon,
} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import {Skeleton} from '@proxy/ui/components/skeleton';
import {BalancesWidget} from '@/components/widgets/balances-widget';
import {CalendarWidget} from '@/components/widgets/calendar-widget';
import {ConvertWidget} from '@/components/widgets/convert-widget';
import {EditEventWidget} from '@/components/widgets/edit-event-widget';
import {EventWidget} from '@/components/widgets/event-widget';
import {FindEmailWidget} from '@/components/widgets/find-email-widget';
import {FindFileWidget} from '@/components/widgets/find-file-widget';
import {MathWidget} from '@/components/widgets/math-widget';
import {PersonWidget} from '@/components/widgets/person-widget';
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

// The widget the api picked, filled with its fields; nothing for `none`. The ids are the
// api's (`packages/api/src/intent/widgets.ts`).
export function IntentWidget({intent, typed, now, onAsk}: Props) {
	const id = intent.widget;
	if (id === 'new_event') {
		return <EventWidget intent={intent} typed={typed} now={now} />;
	}
	if (id === 'change_event') {
		return <EditEventWidget intent={intent} typed={typed} now={now} />;
	}
	if (id === 'show_calendar') {
		return <CalendarWidget intent={intent} typed={typed} now={now} />;
	}
	if (id === 'find_person') {
		return <PersonWidget intent={intent} onAsk={onAsk} />;
	}
	if (id === 'write_email') {
		return <WriteEmailWidget intent={intent} typed={typed} />;
	}
	if (id === 'find_email') {
		return <FindEmailWidget intent={intent} typed={typed} now={now} />;
	}
	if (id === 'find_file') {
		return <FindFileWidget intent={intent} typed={typed} />;
	}
	if (id === 'calculate') {
		return <MathWidget intent={intent} />;
	}
	if (id === 'convert_units') {
		return <ConvertWidget intent={intent} />;
	}
	if (id === 'show_balances') {
		return <BalancesWidget intent={intent} />;
	}
	if (id === 'find_transactions') {
		return <TransactionsWidget intent={intent} typed={typed} now={now} />;
	}
	return null;
}

// What each widget is called and its icon, as it shows them, for its frame while its fields are
// filled in.
const FRAMES: Partial<Record<string, {icon: LucideIcon; name: string}>> = {
	new_event: {icon: CalendarIcon, name: 'New event'},
	change_event: {icon: CalendarIcon, name: 'Change event'},
	show_calendar: {icon: CalendarDaysIcon, name: 'Calendar'},
	find_person: {icon: UserRoundIcon, name: 'Person'},
	write_email: {icon: MailIcon, name: 'Write email'},
	find_email: {icon: InboxIcon, name: 'Find email'},
	find_file: {icon: FileSearchIcon, name: 'Find file'},
	calculate: {icon: CalculatorIcon, name: 'Math'},
	convert_units: {icon: ArrowRightLeftIcon, name: 'Convert units'},
	show_balances: {icon: LandmarkIcon, name: 'Balances'},
	find_transactions: {icon: ReceiptTextIcon, name: 'Transactions'},
};

// The widget the api picked, as soon as it is picked: its frame, until its fields are filled in.
export function FillingWidget({widget}: {widget: string}) {
	const frame = FRAMES[widget];
	if (!frame) {
		return null;
	}
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

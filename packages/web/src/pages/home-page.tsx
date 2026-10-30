import type {FetchError} from '@proxy/utils';
import {useEffect, useRef, useState} from 'react';
import {useLoaderData} from 'react-router';
import {INCOMPLETE, NO_WIDGET, type WidgetId} from '@proxy/contracts/intent';
import {fillIntent, type Intent, pickIntent} from '@/client/intent-client';
import {AgentTimeline} from '@/components/agent-timeline';
import {AnimatedHeight} from '@/components/animated-height';
import {ConnectedLogos} from '@/components/connected-logos';
import {AppShell} from '@/components/app-shell';
import {FillingWidget, IntentWidget} from '@/components/widgets/intent-widget';
import {UnsupportedWidget} from '@/components/widgets/unsupported-widget';
import {Input} from '@proxy/ui/components/input';
import {apiMessage} from '@/lib/agent-errors';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';
import type {homeLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';
import {useHuman} from '@/hooks/use-human';
import type {Human} from '@/lib/orgs';

// How often what is typed is classified while typing goes on.
const INTERVAL_MS = 300;

// How long typing has to stop before what fits no quick action says so: a pause mid-sentence is
// shorter than that more often than not.
const PAUSE_MS = 600;

// What the empty input suggests, one after another: things the widgets do well, one per widget.
const EXAMPLES = [
	'Book lunch with Jacky tomorrow at 1',
	"What's on my calendar tomorrow?",
	'When am I meeting Hugo?',
	'Move my 1:1 with Hugo to Thursday at 4',
	'Find the email about my flight to SFO',
	'Email Jon asking for a 1:1 next week',
	"What's Hugo's phone number?",
	'Find the pricing spreadsheet Paul shared',
	"What's an 18% tip on $86.40?",
	'72°F in Celsius',
	"What's my checking balance?",
	'How much did I spend on restaurants last month?',
];

// How long each example shows.
const EXAMPLE_MS = 3500;

function intentErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && error.status === 503) {
		return apiMessage(error.body) ?? 'Classifying is not set up on this server.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'The model could not be reached. Try again in a moment.';
	}
	return 'Something went wrong. Try again.';
}

function greeting(me: Human | null, now: Date): string {
	const hour = now.getHours();
	const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
	const [first] = (me?.user.name ?? '').split(' ');
	return first ? `Good ${part}, ${first}` : `Good ${part}`;
}

// An answer, with the text it was for and when it came: a widget reads its times against that.
// `follows` when it came while the answer before it said nothing fits, on screen. `filling` while
// the widget is picked and its fields are still to come.
type Answer = {intent: Intent; text: string; at: Date; follows: boolean; filling: boolean};

// Whether an answer of no widget says so: the model tells text still being typed (`incomplete`,
// never kept) from a whole request no widget does (`none`), and as a backstop, `none` waits until
// typing has paused on the text it was for, then stays while typing goes on until a widget fits.
function saysUnsupported(answer: Answer, pausedOn: string): boolean {
	return answer.intent.widget === NO_WIDGET && (answer.text === pausedOn || answer.follows);
}

// The start page, as Sana's: one input, and as it is typed in, it comes forward over the page,
// which blurs behind it, and opens into the widget for what is typed, the input at its top. The api
// picks the widget every 300 ms while typing goes on, and it shows at once, then fills in when its
// fields come; Esc, or a click beside it, puts it back.
export function HomePage() {
	const org = useOrgSlug();
	const me = useHuman();
	const {connections, agents, activity} = useLoaderData<typeof homeLoader>();
	// The time the page opened, for its greeting.
	const [opened] = useState(() => new Date());
	const [text, setText] = useState('');
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The text typing last paused on for `PAUSE_MS`, as state for the page and as a ref for the
	// answers coming in.
	const [pausedOn, setPausedOn] = useState('');
	const pausedOnNow = useRef('');
	const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
	// What is typed now, trimmed, and what the last request was sent with.
	const typed = useRef('');
	const sent = useRef('');
	// Requests are numbered as they are sent. An answer is shown when it is newer than the one on
	// screen, so answers keep coming while typing goes on, but a slow one never replaces a newer one:
	// `shown` is the newest pick on screen, `filled` the newest fields.
	const sequence = useRef(0);
	const shown = useRef(0);
	const filled = useRef(0);
	const tick = useRef<ReturnType<typeof setTimeout>>(undefined);
	const input = useRef<HTMLInputElement>(null);

	useEffect(
		() => () => {
			clearTimeout(tick.current);
			clearTimeout(pause.current);
		},
		[],
	);

	const pauseOn = (words: string) => {
		pausedOnNow.current = words;
		setPausedOn(words);
	};

	// The fields of `widget`, picked for `words`, shown when it is still the widget on screen and no
	// newer fields are.
	const fill = (words: string, widget: WidgetId, request: number) => {
		void fillIntent(org, words, widget).then((result) => {
			if (request <= filled.current) {
				return;
			}
			if (result.isErr()) {
				if (request === shown.current) {
					setError(intentErrorMessage(result.error));
				}
				return;
			}
			filled.current = request;
			if (request === shown.current) {
				setError(null);
			}
			const {fields} = result.value;
			setAnswer((previous) =>
				previous?.intent.widget === widget
					? {...previous, intent: {widget, fields}, text: words, at: new Date(), filling: false}
					: previous,
			);
		});
	};

	const send = () => {
		tick.current = undefined;
		const words = typed.current;
		if (words === '' || words === sent.current) {
			return;
		}

		sent.current = words;
		sequence.current += 1;
		const request = sequence.current;
		void pickIntent(org, words).then((result) => {
			if (request <= shown.current) {
				return;
			}
			shown.current = request;
			if (result.isErr()) {
				setError(intentErrorMessage(result.error));
				return;
			}
			setError(null);
			const widget = result.value.widget;
			// Too little to tell yet: what is on screen stays until there is more.
			if (widget === INCOMPLETE) {
				return;
			}
			// The widget on screen, picked again, stays as it is filled in until its new fields come.
			setAnswer((previous) =>
				previous?.intent.widget === widget && widget !== NO_WIDGET
					? previous
					: {
							intent: {widget, fields: []},
							text: words,
							at: new Date(),
							follows: previous !== null && saysUnsupported(previous, pausedOnNow.current),
							filling: widget !== NO_WIDGET,
						},
			);
			if (widget !== NO_WIDGET) {
				fill(words, widget, request);
			}
		});
	};

	// Typing starts a tick that sends what is typed by its end, and the next keystroke the next
	// tick: a request every `INTERVAL_MS` while typing goes on, the last one with the final text.
	const change = (value: string) => {
		const starting = typed.current === '';
		setText(value);
		typed.current = value.trim();
		if (typed.current !== '') {
			// The last widget was kept while the card folded away; a new start shows none of it.
			if (starting) {
				setAnswer(null);
				setError(null);
			}
			tick.current ??= setTimeout(send, INTERVAL_MS);
			clearTimeout(pause.current);
			pause.current = setTimeout(() => pauseOn(typed.current), PAUSE_MS);
			return;
		}

		// Cleared: the card folds away with what it showed, and the answers still on their way are
		// for text that's gone.
		clearTimeout(tick.current);
		tick.current = undefined;
		clearTimeout(pause.current);
		pauseOn('');
		sent.current = '';
		shown.current = sequence.current;
		filled.current = sequence.current;
	};

	// A widget asking for something else, as Person's Find emails does: it is typed in anew, and the
	// card shows what it showed until the answer for the new text comes.
	const ask = (value: string) => {
		change(value);
		input.current?.focus();
	};

	const active = text.trim() !== '';
	const shownWidget = () => {
		if (!answer) {
			return null;
		}
		if (answer.filling) {
			return <FillingWidget widget={answer.intent.widget} />;
		}
		if (answer.intent.widget !== NO_WIDGET) {
			return (
				<IntentWidget intent={answer.intent} typed={answer.text} now={answer.at} onAsk={ask} />
			);
		}
		return saysUnsupported(answer, pausedOn) ? <UnsupportedWidget agents={agents} /> : null;
	};
	const widget = shownWidget();
	const open = active && (widget !== null || error !== null);

	return (
		<AppShell>
			<div
				aria-hidden
				onClick={() => change('')}
				className={`fixed inset-0 z-30 bg-background/50 backdrop-blur-sm transition-opacity duration-300 ease-out motion-reduce:transition-none ${active ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
			/>
			<div className="flex flex-col items-center gap-6 pt-[16vh]">
				<h1 className="text-sm font-medium">{greeting(me, opened)}</h1>
				<div
					className={`relative z-40 w-full max-w-2xl overflow-hidden rounded-2xl border bg-card transition-[translate,box-shadow] duration-300 ease-out motion-reduce:transition-none ${active ? '-translate-y-[8vh] shadow-2xl' : 'shadow-sm'}`}
				>
					{!active && <QuickActions examples={EXAMPLES} />}
					{active && (
						<button
							type="button"
							aria-label="Dismiss"
							onClick={() => {
								change('');
								input.current?.focus();
							}}
							className="absolute top-3 right-4 z-10 rounded-md border px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground animate-in fade-in-0 duration-300 motion-reduce:animate-none"
						>
							Esc
						</button>
					)}
					<Input
						ref={input}
						autoFocus
						// A search, not a login: password managers offer themselves on no search field
						// (Bitwarden doesn't heed data-bwignore here), browsers suggest nothing, and the
						// clear button search fields get is hidden, as Esc and the key beside it clear it.
						type="search"
						{...NO_PASSWORD_MANAGER}
						aria-label="Quick actions"
						value={text}
						onChange={(event) => change(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								change('');
							}
						}}
						className="h-12 appearance-none rounded-none border-0 bg-transparent pr-16 pl-4 shadow-none focus-visible:ring-0 dark:bg-transparent [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
					/>
					<AnimatedHeight open={open}>
						<div className="border-t">
							{error && <p className="p-4 text-sm text-destructive">{error}</p>}
							{!error && widget && (
								<div
									key={answer?.intent.widget}
									className="animate-in duration-300 fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
								>
									{widget}
								</div>
							)}
						</div>
					</AnimatedHeight>
				</div>
				<ConnectedLogos connections={connections} agents={agents} />
				{activity && (
					<div className="flex w-full justify-center pt-[6vh]">
						<AgentTimeline initial={activity} agents={agents} connections={connections} />
					</div>
				)}
			</div>
		</AppShell>
	);
}

// The empty input's placeholder: "Quick actions:" and an example of what to type, the next fading in
// every few seconds. Drawn over the input, since a placeholder can't fade.
function QuickActions({examples}: {examples: string[]}) {
	const [index, setIndex] = useState(0);

	useEffect(() => {
		const timer = setInterval(
			() => setIndex((current) => (current + 1) % examples.length),
			EXAMPLE_MS,
		);
		return () => clearInterval(timer);
	}, [examples.length]);

	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-4 top-0 flex h-12 items-center gap-1 text-base whitespace-nowrap text-muted-foreground md:text-sm"
		>
			<span>Quick actions:</span>
			<span
				key={index}
				className="truncate animate-in duration-500 fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none"
			>
				{examples[index]}
			</span>
		</div>
	);
}

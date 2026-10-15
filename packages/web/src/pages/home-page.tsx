import type {FetchError} from '@proxy/utils';
import {useEffect, useRef, useState} from 'react';
import {useLoaderData, useRouteLoaderData} from 'react-router';
import {classifyIntent, type Intent} from '@/client/intent-client';
import type {Me} from '@/client/me-client';
import {AnimatedHeight} from '@/components/animated-height';
import {ConnectedLogos} from '@/components/connected-logos';
import {AppShell} from '@/components/app-shell';
import {IntentWidget} from '@/components/widgets/intent-widget';
import {Input} from '@proxy/ui/components/input';
import {apiMessage} from '@/lib/agent-errors';
import type {homeLoader} from '@/loaders';

// How often what is typed is classified while typing goes on.
const INTERVAL_MS = 300;

// What the empty input suggests, one after another: things the widgets do well, one per widget.
const EXAMPLES = [
	'Book lunch with Jacky tomorrow at 1',
	'Find the email about my flight to SFO',
	'Email Jon asking for a 1:1 next week',
	"What's Hugo's phone number?",
	'Find the pricing spreadsheet Paul shared',
	"What's an 18% tip on $86.40?",
	'72°F in Celsius',
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

function greeting(me: Me | undefined, now: Date): string {
	const hour = now.getHours();
	const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
	const [first] = (me?.user.name ?? '').split(' ');
	return first ? `Good ${part}, ${first}` : `Good ${part}`;
}

// An answer, with the text it was for and when it came: a widget reads its times against that.
type Answer = {intent: Intent; text: string; at: Date};

// The start page, as Sana's: one input, and as it is typed in, it comes forward over the page,
// which blurs behind it, and opens into the widget for what is typed, the input at its top. The api
// picks the widget and fills it, every 300 ms while typing goes on; Esc, or a click beside it, puts
// it back.
export function HomePage() {
	const me = useRouteLoaderData<Me>('human');
	const {connections, agents} = useLoaderData<typeof homeLoader>();
	// The time the page opened, for its greeting.
	const [opened] = useState(() => new Date());
	const [text, setText] = useState('');
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [error, setError] = useState<string | null>(null);
	// What is typed now, trimmed, and what the last request was sent with.
	const typed = useRef('');
	const sent = useRef('');
	// Requests are numbered as they are sent. An answer is shown when it is newer than the one on
	// screen, so answers keep coming while typing goes on, but a slow one never replaces a newer one.
	const sequence = useRef(0);
	const shown = useRef(0);
	const tick = useRef<ReturnType<typeof setTimeout>>(undefined);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => () => clearTimeout(tick.current), []);

	const send = () => {
		tick.current = undefined;
		const words = typed.current;
		if (words === '' || words === sent.current) {
			return;
		}

		sent.current = words;
		sequence.current += 1;
		const request = sequence.current;
		void classifyIntent(words).then((result) => {
			if (request <= shown.current) {
				return;
			}
			shown.current = request;
			if (result.isErr()) {
				setError(intentErrorMessage(result.error));
				return;
			}
			setError(null);
			setAnswer({intent: result.value, text: words, at: new Date()});
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
			return;
		}

		// Cleared: the card folds away with what it showed, and the answers still on their way are
		// for text that's gone.
		clearTimeout(tick.current);
		tick.current = undefined;
		sent.current = '';
		shown.current = sequence.current;
	};

	// A widget asking for something else, as Person's Find emails does: it is typed in anew, and the
	// card shows what it showed until the answer for the new text comes.
	const ask = (value: string) => {
		change(value);
		input.current?.focus();
	};

	const active = text.trim() !== '';
	const widget =
		answer && answer.intent.widget !== 'none' ? (
			<IntentWidget intent={answer.intent} typed={answer.text} now={answer.at} onAsk={ask} />
		) : null;
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
					{!active && <QuickActions />}
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
						autoComplete="off"
						data-bwignore
						data-1p-ignore
						data-lpignore="true"
						data-form-type="other"
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
			</div>
		</AppShell>
	);
}

// The empty input's placeholder: "Quick actions:" and an example of what to type, the next fading in
// every few seconds. Drawn over the input, since a placeholder can't fade.
function QuickActions() {
	const [index, setIndex] = useState(0);

	useEffect(() => {
		const timer = setInterval(
			() => setIndex((current) => (current + 1) % EXAMPLES.length),
			EXAMPLE_MS,
		);
		return () => clearInterval(timer);
	}, []);

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
				{EXAMPLES[index]}
			</span>
		</div>
	);
}

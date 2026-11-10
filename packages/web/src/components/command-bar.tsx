import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {ChatPersona} from '@proxy/contracts/harness';
import {CHAT_WIDGET_IDS, INCOMPLETE, NO_WIDGET, type WidgetId} from '@proxy/contracts/intent';
import type {FetchError} from '@proxy/utils';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useNavigate} from 'react-router';
import {listPersonas} from '@/client/harness-client';
import {fillIntent, type Intent, pickIntent} from '@/client/intent-client';
import {AnimatedHeight} from '@/components/animated-height';
import {CommandRows} from '@/components/command-rows';
import {AgentWidget} from '@/components/widgets/agent-widget';
import {FillingWidget, IntentWidget} from '@/components/widgets/intent-widget';
import {UnsupportedWidget} from '@/components/widgets/unsupported-widget';
import {Input} from '@proxy/ui/components/input';
import {Skeleton} from '@proxy/ui/components/skeleton';
import {cn} from '@proxy/ui/lib/utils';
import {useOwnCommandBar} from '@/hooks/use-command-palette';
import {useExperiments} from '@/hooks/use-experiment';
import {useHuman} from '@/hooks/use-human';
import {useOrgSlug} from '@/hooks/use-org';
import {apiMessage} from '@/lib/agent-errors';
import {
	addressedPersona,
	type Destination,
	destinationsOf,
	findDestinations,
	personaFor,
	rowId,
} from '@/lib/command-bar';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';

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

// What it suggests beside them where the organization has Chat: an agent made, and one asked.
const CHAT_EXAMPLES = [
	'Add an agent that reminds me to stretch every hour',
	'Plan my trip to Lisbon in March',
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

// Whether a widget does what its main button does at once, where Enter was pressed on what is
// typed before it showed: those that work with Chat's agents. A quick action waits for Enter
// again once it is on screen to be looked over, since it writes to the person's accounts.
function actsAtOnce(widget: Intent['widget']): boolean {
	return widget !== NO_WIDGET && CHAT_WIDGET_IDS.includes(widget);
}

// Chat's agents as the person sees them, read as the bar opens, for where it goes and whom it
// sends a message to; null until they have come, where they couldn't be read, and without Chat.
function useChatPersonas(org: string, chat: boolean): ChatPersona[] | null {
	const [personas, setPersonas] = useState<ChatPersona[] | null>(null);
	useEffect(() => {
		if (!chat) {
			return;
		}
		let current = true;
		void listPersonas(org).then((result) => {
			if (current && result.isOk()) {
				setPersonas(result.value.personas);
			}
		});
		return () => {
			current = false;
		};
	}, [org, chat]);
	return chat ? personas : null;
}

type Props = {
	// On a page of its own, as Home, where it comes forward over the page as it is typed in; or
	// in a dialog over any other (command-palette.tsx), which lists where to go before anything
	// is typed.
	place: 'page' | 'dialog';
	// What is connected and the external agents, to go to; null while they load.
	connections: Connection[] | null;
	agents: AgentLogin[] | null;
	// Closes the dialog it is in.
	onClose?: () => void;
};

/**
 * The command bar, as Sana's: one input that goes somewhere, does a quick action, or hands what
 * is typed to an agent. As it is typed in, it lists the pages, conversations, connections and
 * external agents the words lead to, which Enter opens; the api picks the widget for what is
 * typed every 300 ms while typing goes on, which shows at once and fills in when its fields come.
 * In an organization with Chat, a wish for a new agent opens into one to make, and what no quick
 * action does into a message to one of Chat's agents, General unless the text names another;
 * Enter makes the one and sends the other, and leads to the conversation. A text said to an agent
 * by name ("ask Finance …") is a message to it, of what follows the name, without being classified
 * at all.
 */
export function CommandBar({place, connections, agents, onClose}: Props) {
	const here = useOrgSlug();
	const human = useHuman();
	// On the person's account page the address names no organization: the bar goes to their first
	// one's pages, and classifies nothing, as the widgets work in the address's organization.
	const org = here === '' ? (human?.org.slug ?? '') : here;
	const asks = here !== '';
	// Whether the organization has Chat (the `harness` experiment), whose agents it then goes to,
	// makes and sends messages to.
	const chat = useExperiments().includes('harness');
	const navigate = useNavigate();
	const personas = useChatPersonas(org, chat);
	const [text, setText] = useState('');
	const [answer, setAnswer] = useState<Answer | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The row Enter opens, among where what is typed leads.
	const [selected, setSelected] = useState(0);
	// The text Enter was pressed on before there was anything for it to do, as state for the bar
	// and as a ref for the answers coming in: whatever the answer for it is for, it does at once.
	const [entered, setEntered] = useState<string | null>(null);
	const enteredNow = useRef<string | null>(null);
	// What Enter does where a widget on screen takes it (hooks/use-bar-action.ts).
	const action = useRef<(() => void) | null>(null);
	// The text typing last paused on for `PAUSE_MS`, as state for the bar and as a ref for the
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

	const focus = useCallback(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	useOwnCommandBar(focus, place === 'page');

	const destinations = useMemo(
		() => destinationsOf({org, chat, personas, connections, agents}),
		[org, chat, personas, connections, agents],
	);
	const words = text.trim();
	const rows = useMemo(() => {
		if (words !== '') {
			return findDestinations(words, destinations);
		}
		return place === 'dialog' ? destinations : [];
	}, [words, destinations, place]);
	// The agent the text is said to by name, which makes it a message to that agent.
	const addressed = asks && personas !== null ? addressedPersona(text, personas) : null;

	const pauseOn = (paused: string) => {
		pausedOnNow.current = paused;
		setPausedOn(paused);
	};

	const enter = (on: string | null) => {
		enteredNow.current = on;
		setEntered(on);
	};

	// The fields of `widget`, picked for `asked`, shown when it is still the widget on screen and
	// no newer fields are.
	const fill = (asked: string, widget: WidgetId, request: number) => {
		void fillIntent(org, asked, widget).then((result) => {
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
					? {...previous, intent: {widget, fields}, text: asked, at: new Date(), filling: false}
					: previous,
			);
		});
	};

	const send = () => {
		tick.current = undefined;
		const asked = typed.current;
		if (asked === '' || asked === sent.current) {
			return;
		}

		sent.current = asked;
		sequence.current += 1;
		const request = sequence.current;
		void pickIntent(org, asked).then((result) => {
			if (request <= shown.current) {
				return;
			}
			shown.current = request;
			if (result.isErr()) {
				setError(intentErrorMessage(result.error));
				return;
			}
			setError(null);
			const picked = result.value.widget;
			// Too little to tell yet: what is on screen stays until there is more. With Enter pressed
			// on it, it is all there will be, and no widget does it.
			if (picked === INCOMPLETE && enteredNow.current !== asked) {
				return;
			}
			const widget = picked === INCOMPLETE ? NO_WIDGET : picked;
			// The widget on screen, picked again, stays as it is filled in until its new fields come.
			setAnswer((previous) =>
				previous?.intent.widget === widget && widget !== NO_WIDGET
					? previous
					: {
							intent: {widget, fields: []},
							text: asked,
							at: new Date(),
							follows: previous !== null && saysUnsupported(previous, pausedOnNow.current),
							filling: widget !== NO_WIDGET,
						},
			);
			if (widget !== NO_WIDGET) {
				fill(asked, widget, request);
			}
		});
	};

	// The answers still on their way are for text that is gone, or that is not to be classified.
	const drop = () => {
		clearTimeout(tick.current);
		tick.current = undefined;
		sent.current = '';
		shown.current = sequence.current;
		filled.current = sequence.current;
	};

	// Typing starts a tick that sends what is typed by its end, and the next keystroke the next
	// tick: a request every `INTERVAL_MS` while typing goes on, the last one with the final text.
	const change = (value: string) => {
		const starting = typed.current === '';
		setText(value);
		setSelected(0);
		enter(null);
		typed.current = value.trim();
		if (typed.current === '') {
			// Cleared: the card folds away with what it showed.
			drop();
			clearTimeout(pause.current);
			pauseOn('');
			return;
		}

		// Said to an agent by name, or on a page with nothing to classify for: no widget is picked.
		if (!asks || (personas !== null && addressedPersona(value, personas) !== null)) {
			drop();
			setAnswer(null);
			setError(null);
			return;
		}

		// The last widget was kept while the card folded away; a new start shows none of it.
		if (starting) {
			setAnswer(null);
			setError(null);
		}
		tick.current ??= setTimeout(send, INTERVAL_MS);
		clearTimeout(pause.current);
		pause.current = setTimeout(() => pauseOn(typed.current), PAUSE_MS);
	};

	// A widget asking for something else, as Person's Find emails does: it is typed in anew, and the
	// card shows what it showed until the answer for the new text comes.
	const ask = (value: string) => {
		change(value);
		input.current?.focus();
	};

	// Somewhere else: the bar is left as it was found, and the dialog it is in closed.
	const leave = (to: string) => {
		change('');
		onClose?.();
		void navigate(to);
	};

	const open = (destination: Destination) => leave(destination.to);

	// Enter opens the lit row where what is typed leads somewhere. Otherwise it presses the main
	// button of the widget on screen, where that is for what is typed now and can be pressed
	// (widgets/enter-button.tsx). With neither, it asks for the answer to what is typed at once:
	// a message to an agent, or an agent to make, is then done as soon as the answer comes, and a
	// quick action shows, for Enter to press its button once it has been looked over.
	const onEnter = () => {
		const row = rows[selected];
		if (row) {
			open(row);
			return;
		}
		const asked = typed.current;
		if (asked === '') {
			return;
		}
		const current = answer !== null && answer.text === asked && !answer.filling;
		if (action.current && (addressed !== null || current || answer?.intent.widget === NO_WIDGET)) {
			action.current();
			return;
		}
		if (!asks || (current && answer.intent.widget !== NO_WIDGET)) {
			return;
		}
		enter(asked);
		if (current) {
			return;
		}
		clearTimeout(tick.current);
		sent.current = '';
		send();
	};

	const setAction = useCallback((act: (() => void) | null) => {
		action.current = act;
	}, []);
	// Whether Enter was pressed on `asked` before the widget for it showed, and whether Enter is a
	// widget's at all: what a widget whose action is Enter's is handed, with the two above.
	const enteredOn = (asked: string) => entered !== null && entered === asked;
	const onEnterKey = rows.length === 0;

	const active = words !== '';
	// What the card shows under the rows, and what it is keyed by, so one widget fades in after
	// another, and one made anew once Enter was pressed for its text does its action then.
	const card = (): {key: string; view: ReactNode} | null => {
		if (addressed !== null && personas !== null) {
			return {
				key: 'agent',
				view: (
					<AgentWidget
						text={addressed.message}
						quoted
						personas={personas}
						suggested={addressed.persona}
						bar={{
							entered: enteredOn(words),
							onEnter: onEnterKey,
							setAction,
							done: leave,
						}}
					/>
				),
			};
		}
		if (!answer) {
			return null;
		}
		const {widget} = answer.intent;
		if (answer.filling) {
			return {key: widget, view: <FillingWidget widget={widget} />};
		}
		if (widget !== NO_WIDGET) {
			const pressed = actsAtOnce(widget) && enteredOn(answer.text);
			return {
				key: pressed ? `${widget}:entered` : widget,
				view: (
					<IntentWidget
						intent={answer.intent}
						typed={answer.text}
						now={answer.at}
						onAsk={ask}
						bar={{entered: pressed, onEnter: onEnterKey, setAction, done: leave}}
					/>
				),
			};
		}
		if (!saysUnsupported(answer, pausedOn) && entered !== answer.text) {
			return null;
		}
		// What is typed names somewhere to go, which is what Enter does.
		if (rows.length > 0) {
			return null;
		}
		if (personas !== null && personas.length > 0) {
			return {
				key: 'agent',
				view: (
					<AgentWidget
						text={words}
						personas={personas}
						suggested={personaFor(words, personas)}
						bar={{
							entered: enteredOn(words),
							onEnter: onEnterKey,
							setAction,
							done: leave,
						}}
					/>
				),
			};
		}
		return {key: NO_WIDGET, view: <UnsupportedWidget agents={agents ?? []} />};
	};
	const shownCard = card();
	// Enter was pressed, and the answer it waits for has not come.
	const waiting = shownCard === null && error === null && entered !== null && rows.length === 0;
	const opened =
		(active || place === 'dialog') &&
		(rows.length > 0 || shownCard !== null || error !== null || waiting);
	const lit = rows[selected];

	return (
		<>
			{place === 'page' && (
				<div
					aria-hidden
					onClick={() => change('')}
					className={`fixed inset-0 z-30 bg-background/50 backdrop-blur-sm transition-opacity duration-300 ease-out motion-reduce:transition-none ${active ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
				/>
			)}
			<div
				className={cn(
					'relative w-full overflow-hidden',
					place === 'page' &&
						'z-40 max-w-2xl rounded-2xl border bg-card transition-[translate,box-shadow] duration-300 ease-out motion-reduce:transition-none',
					place === 'page' && (active ? '-translate-y-[8vh] shadow-2xl' : 'shadow-sm'),
				)}
			>
				{!active && (
					<QuickActions examples={chat && asks ? [...EXAMPLES, ...CHAT_EXAMPLES] : EXAMPLES} />
				)}
				{(active || place === 'dialog') && (
					<button
						type="button"
						aria-label={place === 'dialog' ? 'Close' : 'Dismiss'}
						onClick={() => {
							if (place === 'dialog') {
								onClose?.();
								return;
							}
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
					aria-controls={rows.length > 0 ? 'command-rows' : undefined}
					aria-activedescendant={lit ? rowId(lit) : undefined}
					value={text}
					onChange={(event) => change(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && place === 'page') {
							change('');
							return;
						}
						if (event.nativeEvent.isComposing) {
							return;
						}
						if (event.key === 'Enter') {
							event.preventDefault();
							onEnter();
							return;
						}
						if (rows.length === 0 || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) {
							return;
						}
						event.preventDefault();
						const step = event.key === 'ArrowDown' ? 1 : -1;
						setSelected((selected + step + rows.length) % rows.length);
					}}
					className="h-12 appearance-none rounded-none border-0 bg-transparent pr-16 pl-4 shadow-none focus-visible:ring-0 dark:bg-transparent [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
				/>
				<AnimatedHeight open={opened}>
					{/* What is typed opens into a card on the input's own surface, as under Chat's message
					    box, with no line between them; only the rows it leads to are set apart from it. */}
					<div className={cn(rows.length > 0 && 'border-t')}>
						{rows.length > 0 && (
							<CommandRows rows={rows} selected={selected} onSelect={setSelected} onOpen={open} />
						)}
						{error && (
							<p
								className={cn(
									'px-4 pb-3 text-xs text-destructive',
									rows.length > 0 && 'border-t pt-3',
								)}
							>
								{error}
							</p>
						)}
						{!error && shownCard && (
							<div
								key={shownCard.key}
								className={cn(
									'animate-in duration-300 fade-in-0 slide-in-from-top-1 motion-reduce:animate-none',
									rows.length > 0 && 'border-t pt-3',
								)}
							>
								{shownCard.view}
							</div>
						)}
						{waiting && <Waiting />}
					</div>
				</AnimatedHeight>
			</div>
		</>
	);
}

// Enter was pressed on what is typed, and what it is for is being worked out.
function Waiting() {
	return (
		<div role="status" aria-label="Working it out" className="flex flex-col gap-3 px-4 pb-3">
			<Skeleton className="h-4 w-2/3" />
			<Skeleton className="h-4 w-1/2" />
		</div>
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
				{examples[index % examples.length]}
			</span>
		</div>
	);
}

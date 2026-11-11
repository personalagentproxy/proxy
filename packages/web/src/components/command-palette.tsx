import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {ChatPersona} from '@proxy/contracts/harness';
import {Ok} from 'ts-results-es';
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {useLocation} from 'react-router';
import {listAgents} from '@/client/agents-client';
import {listConnections} from '@/client/connections-client';
import {listPersonas} from '@/client/harness-client';
import {CommandBar} from '@/components/command-bar';
import {Dialog, DialogContent, DialogTitle} from '@proxy/ui/components/dialog';
import {CommandPaletteContext} from '@/hooks/use-command-palette';
import {useExperiments} from '@/hooks/use-experiment';
import {useHuman} from '@/hooks/use-human';
import {isShortcut} from '@/lib/platform';

// What the bar goes to and sends messages to, in `org`: what is connected, the external agents,
// and Chat's agents as the person sees them; each null until it has come, where it couldn't be
// read, and Chat's without Chat.
type BarLists = {
	org: string;
	connections: Connection[] | null;
	agents: AgentLogin[] | null;
	personas: ChatPersona[] | null;
};

const NOTHING_READ = {connections: null, agents: null, personas: null};

// How long lists read as the bar opened are new enough for it to open again on the same page
// without reading them again, as when it is opened and closed in a row.
const FRESH_MS = 30_000;

// The lists, kept from one opening of the bar to the next, so it goes to what there is without
// waiting for it: what was read last shows meanwhile, and stays where it can't be read again.
// They are read again as it opens, unless it was opened on the same page a moment ago, as it then
// has what there is. Another organization's are none of this one's.
function useBarLists(org: string, chat: boolean, open: boolean, page: string): BarLists {
	const [lists, setLists] = useState<BarLists>({org, ...NOTHING_READ});
	// When all of them were last read, and for what.
	const read = useRef<{org: string; chat: boolean; page: string; at: number} | null>(null);

	useEffect(() => {
		if (!open || org === '') {
			return;
		}
		const last = read.current;
		if (
			last !== null &&
			last.org === org &&
			last.chat === chat &&
			last.page === page &&
			Date.now() - last.at < FRESH_MS
		) {
			return;
		}
		let current = true;
		void Promise.all([
			listConnections(org),
			listAgents(org),
			chat ? listPersonas(org) : Promise.resolve(Ok(null)),
		]).then(([connections, agents, personas]) => {
			if (!current) {
				return;
			}
			if (connections.isOk() && agents.isOk() && personas.isOk()) {
				read.current = {org, chat, page, at: Date.now()};
			}
			setLists((previous) => {
				const kept = previous.org === org ? previous : NOTHING_READ;
				return {
					org,
					connections: connections.map((answer) => answer.connections).unwrapOr(kept.connections),
					agents: agents.map((answer) => answer.agents).unwrapOr(kept.agents),
					personas: personas.map((answer) => answer?.personas ?? null).unwrapOr(kept.personas),
				};
			});
		});
		return () => {
			current = false;
		};
	}, [org, chat, open, page]);

	if (lists.org !== org) {
		return {org, ...NOTHING_READ};
	}
	return chat ? lists : {...lists, personas: null};
}

/**
 * Around the human side's pages: Cmd+K (Ctrl+K off a Mac) opens the command bar in a dialog over
 * whatever page is up, and closes it again. The dialog is the page's it was opened on, so going
 * anywhere closes it, for good: back on that page, it stays closed.
 */
export function CommandPaletteProvider({children}: {children: ReactNode}) {
	// The sidebar's organization: the address's, or on the person's account page, their first.
	const org = useHuman()?.org.slug ?? '';
	const {pathname} = useLocation();
	const [openedOn, setOpenedOn] = useState<string | null>(null);
	// The page, and the shortcut below, are the provider's as the page is drawn, not a moment
	// after: Cmd+K pressed the instant a page shows opens the bar over it.
	const here = useRef(pathname);
	useLayoutEffect(() => {
		here.current = pathname;
	}, [pathname]);
	const toggle = useCallback(() => {
		setOpenedOn((on) => (on === here.current ? null : here.current));
	}, []);
	// Left however it was, a link in a card or the browser's Back as much as Enter, it is closed.
	if (openedOn !== null && openedOn !== pathname) {
		setOpenedOn(null);
	}
	const palette = useMemo(() => ({toggle}), [toggle]);

	useLayoutEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isShortcut(event, 'k') || event.repeat) {
				return;
			}
			event.preventDefault();
			toggle();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [toggle]);

	const close = useCallback(() => setOpenedOn(null), []);
	const open = org !== '' && openedOn === pathname;
	// Whether the organization has Chat (the `harness` experiment), whose agents the bar goes to,
	// makes and sends messages to.
	const chat = useExperiments().includes('harness');
	const lists = useBarLists(org, chat, open, pathname);

	return (
		<CommandPaletteContext value={palette}>
			{children}
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) {
						close();
					}
				}}
			>
				{/* Chat's message box's surface (lib/pill-variants.ts), which the bar and its cards are drawn as. */}
				<DialogContent
					showCloseButton={false}
					className="top-[14vh] max-h-[80dvh] translate-y-0 gap-0 overflow-y-auto rounded-xl bg-background p-0 sm:max-w-2xl"
				>
					<DialogTitle className="sr-only">Go somewhere, or ask for something</DialogTitle>
					<CommandBar
						connections={lists.connections}
						agents={lists.agents}
						personas={lists.personas}
						open={open}
						onClose={close}
					/>
				</DialogContent>
			</Dialog>
		</CommandPaletteContext>
	);
}

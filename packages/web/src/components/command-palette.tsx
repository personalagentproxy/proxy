import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {ChatPersona} from '@proxy/contracts/harness';
import {Ok} from 'ts-results-es';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
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

// The lists, kept from one opening of the bar to the next and read again as it opens, so it goes
// to what there is now without waiting for it: what was read last shows meanwhile, and stays where
// it can't be read again. Another organization's are none of this one's.
function useBarLists(org: string, chat: boolean, open: boolean): BarLists {
	const [lists, setLists] = useState<BarLists>({org, ...NOTHING_READ});

	useEffect(() => {
		if (!open || org === '') {
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
	}, [org, chat, open]);

	if (lists.org !== org) {
		return {org, ...NOTHING_READ};
	}
	return chat ? lists : {...lists, personas: null};
}

/**
 * Around the human side's pages: Cmd+K (Ctrl+K off a Mac) opens the command bar in a dialog over
 * whatever page is up, and closes it again. The dialog is the page's it was opened on, so going
 * anywhere closes it.
 */
export function CommandPaletteProvider({children}: {children: ReactNode}) {
	// The sidebar's organization: the address's, or on the person's account page, their first.
	const org = useHuman()?.org.slug ?? '';
	const {pathname} = useLocation();
	const [openedOn, setOpenedOn] = useState<string | null>(null);
	const here = useRef(pathname);
	useEffect(() => {
		here.current = pathname;
	}, [pathname]);
	const toggle = useCallback(() => {
		setOpenedOn((on) => (on === here.current ? null : here.current));
	}, []);
	const palette = useMemo(() => ({toggle}), [toggle]);

	useEffect(() => {
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
	const lists = useBarLists(org, chat, open);

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
						onClose={close}
					/>
				</DialogContent>
			</Dialog>
		</CommandPaletteContext>
	);
}

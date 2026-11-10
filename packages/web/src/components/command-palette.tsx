import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {type ReactNode, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useLocation} from 'react-router';
import {listAgents} from '@/client/agents-client';
import {listConnections} from '@/client/connections-client';
import {CommandBar} from '@/components/command-bar';
import {Dialog, DialogContent, DialogTitle} from '@proxy/ui/components/dialog';
import {CommandPaletteContext} from '@/hooks/use-command-palette';
import {useHuman} from '@/hooks/use-human';
import {isShortcut} from '@/lib/platform';

// The command bar as the dialog shows it: what is connected and the external agents are read as
// it opens, so it goes to what there is now; until they come, and where they can't be read, it
// goes to the pages alone.
function PaletteBar({org, onClose}: {org: string; onClose: () => void}) {
	const [lists, setLists] = useState<{
		connections: Connection[] | null;
		agents: AgentLogin[] | null;
	}>({connections: null, agents: null});

	useEffect(() => {
		let current = true;
		void Promise.all([listConnections(org), listAgents(org)]).then(([connections, agents]) => {
			if (!current) {
				return;
			}
			setLists({
				connections: connections.map((answer) => answer.connections).unwrapOr(null),
				agents: agents.map((answer) => answer.agents).unwrapOr(null),
			});
		});
		return () => {
			current = false;
		};
	}, [org]);

	return (
		<CommandBar
			place="dialog"
			connections={lists.connections}
			agents={lists.agents}
			onClose={onClose}
		/>
	);
}

/**
 * Around the human side's pages: Cmd+K (Ctrl+K off a Mac) opens the command bar in a dialog over
 * whatever page is up, and closes it again; on a page with the bar on it, as Home, it puts the
 * cursor there instead. The dialog is the page's it was opened on, so going anywhere closes it.
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
	// The page's own bar, where it has one.
	const own = useRef<(() => void) | null>(null);

	const toggle = useCallback(() => {
		if (own.current) {
			own.current();
			return;
		}
		setOpenedOn((on) => (on === here.current ? null : here.current));
	}, []);
	const setOwn = useCallback((focus: (() => void) | null) => {
		own.current = focus;
	}, []);
	const palette = useMemo(() => ({toggle, setOwn}), [toggle, setOwn]);

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

	return (
		<CommandPaletteContext value={palette}>
			{children}
			<Dialog
				open={org !== '' && openedOn === pathname}
				onOpenChange={(next) => {
					if (!next) {
						close();
					}
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="top-[14vh] max-h-[80dvh] translate-y-0 gap-0 overflow-y-auto rounded-2xl bg-card p-0 sm:max-w-2xl"
				>
					<DialogTitle className="sr-only">Go somewhere, or ask for something</DialogTitle>
					<PaletteBar org={org} onClose={close} />
				</DialogContent>
			</Dialog>
		</CommandPaletteContext>
	);
}

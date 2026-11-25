import type {PersonaSlack} from '@proxy/contracts/slack';
import {useCallback, useEffect, useState} from 'react';
import {getPersonaSlack} from '@/client/slack-client';
import {describeApiError} from '@/lib/loader-utils';

/** The persona in Slack as its settings read it, for whoever may change it: its app and the workspaces, read again after each change. */
export type PersonaSlackRead = {
	loaded: PersonaSlack | null;
	failed: string | null;
	reload: () => void;
};

/** Reads the persona in Slack where `enabled`: for a shared one, by whoever may change it. */
export function usePersonaSlack(
	org: string,
	personaId: string,
	enabled: boolean,
): PersonaSlackRead {
	// What was read, and what that failed with, for the persona it was read for.
	const [read, setRead] = useState<{
		personaId: string;
		loaded: PersonaSlack | null;
		failed: string | null;
	} | null>(null);
	// Read again after each change made in the dialog.
	const [reads, setReads] = useState(0);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let current = true;
		void getPersonaSlack(org, personaId).then((answer) => {
			if (!current) {
				return;
			}
			if (answer.isErr()) {
				setRead((before) => ({
					personaId,
					loaded: before?.personaId === personaId ? before.loaded : null,
					failed: describeApiError(answer.error),
				}));
				return;
			}
			setRead({personaId, loaded: answer.value, failed: null});
		});
		return () => {
			current = false;
		};
	}, [org, personaId, enabled, reads]);

	const reload = useCallback(() => setReads((count) => count + 1), []);
	const mine = read?.personaId === personaId ? read : null;
	return {loaded: mine?.loaded ?? null, failed: mine?.failed ?? null, reload};
}

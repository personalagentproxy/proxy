import type {LastMessage, PersonaRow} from '@proxy/db/harness';
import {type Look, preview} from '@proxy/utils/harness';

import {manages} from '../utils/manages';
import type {OrgViewer} from '../utils/user-org';

/** A persona as the Chat page lists it, whether the viewer may change it, and the last thing said in their conversation with it, cut to a line; null before anything was said. */
export type PersonaResponse = {id: string; name: string; look: Look; color: string; mayChange: boolean; lastMessage: {kind: 'person' | 'assistant'; text: string; at: string} | null};

/** Whether the viewer may rename, reface or delete the persona: whoever made it, or the organization's owner (utils/manages.ts). */
export function managesPersona(viewer: OrgViewer, persona: PersonaRow): boolean {
	return manages(viewer, {ownerUserId: null, byId: persona.createdById});
}

/** A persona for a response, with whether the viewer may change it. */
export function toPersona(viewer: OrgViewer, persona: PersonaRow & {lastMessage?: LastMessage | null}): PersonaResponse {
	const last = persona.lastMessage ?? null;
	return {
		id: persona.id,
		name: persona.name,
		look: persona.look,
		color: persona.color,
		mayChange: managesPersona(viewer, persona),
		lastMessage: last && {kind: last.kind, text: preview(last.text), at: last.createdAt.toISOString()},
	};
}

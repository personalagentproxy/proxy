import type {personaListSchema} from '@proxy/contracts/harness';
import type {z} from 'zod';

export type PersonaList = z.infer<typeof personaListSchema>;

// Chat's agents as an organization's list last came, kept for the page's open: the sidebar shows
// them at once as it drills into Chat, rather than once the conversation has loaded beside them,
// and the list as it comes then takes their place.
const remembered = new Map<string, PersonaList>();

export function rememberPersonaList(org: string, list: PersonaList): void {
	remembered.set(org, list);
}

export function rememberedPersonaList(org: string): PersonaList | null {
	return remembered.get(org) ?? null;
}

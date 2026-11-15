import {preview} from '@proxy/utils/harness';

function draftLine(draft: string | null): string | null {
	if (draft === null || draft.trim() === '') {
		return null;
	}
	return preview(draft);
}

// Sidebar row under the name: hide unsent text on the open chat, show it elsewhere.
export function rowDraftPreview(
	current: string,
	personaId: string,
	draft: string | null,
): string | null {
	if (personaId === current) {
		return null;
	}
	return draftLine(draft);
}

/**
 * The models the built-in agent can answer with. Every persona answers with Claude; in an insider
 * organization each can be switched to GLM where it is made or changed, to try it out
 * (`Persona.chatModel`), its sub-agents with it. The value is what the persona dialog calls it.
 */
export const CHAT_MODELS = {
	claude: 'Claude Sonnet 5.5',
	glm: 'GLM 5.3',
} as const satisfies Record<string, string>;

export type ChatModel = keyof typeof CHAT_MODELS;

export function isChatModel(id: string): id is ChatModel {
	return Object.hasOwn(CHAT_MODELS, id);
}

/** A stored model as one there is: Claude for one that is no longer one. */
export function toChatModel(id: string): ChatModel {
	if (!isChatModel(id)) {
		return 'claude';
	}
	return id;
}

/**
 * The model a persona answers with: the one chosen for it, while its organization is an insider;
 * Claude in any other, whatever was chosen while it was one.
 */
export function personaChatModel(persona: {insider: boolean; chatModel: string}): ChatModel {
	if (!persona.insider) {
		return 'claude';
	}
	return toChatModel(persona.chatModel);
}

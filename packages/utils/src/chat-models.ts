/**
 * The models the built-in agent answers with over OpenRouter, on the server's key: the few picked
 * out of what OpenRouter has, which the api's proxy harness lists for a persona to choose from
 * (`Persona.chatModel`), for every thread of its chats. The value is what the persona dialog calls it. A
 * persona on another harness chooses from that harness's own.
 */
export const CHAT_MODELS = {
	claude: 'Claude Sonnet 5.5',
	glm: 'GLM 5.3',
} as const satisfies Record<string, string>;

export type ChatModel = keyof typeof CHAT_MODELS;

export function isChatModel(id: string): id is ChatModel {
	return Object.hasOwn(CHAT_MODELS, id);
}

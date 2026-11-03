/**
 * The models the built-in agent can answer with. Every organization's answers with Claude; an
 * insider organization can switch its own to GLM on its Settings page, to try it out
 * (`Organization.chatModel`). The value is what the Settings page calls it.
 */
export const CHAT_MODELS = {
	claude: 'Claude Sonnet 5.5',
	glm: 'GLM 5.3',
} as const satisfies Record<string, string>;

export type ChatModel = keyof typeof CHAT_MODELS;

export function isChatModel(id: string): id is ChatModel {
	return Object.hasOwn(CHAT_MODELS, id);
}

/**
 * The model an organization chose, where it may choose (an insider); `null` for any other, whose
 * agent answers with Claude whatever was chosen while it was an insider.
 */
export function organizationChatModel(organization: {
	insider: boolean;
	chatModel: string;
}): ChatModel | null {
	if (!organization.insider) {
		return null;
	}
	if (!isChatModel(organization.chatModel)) {
		return 'claude';
	}
	return organization.chatModel;
}

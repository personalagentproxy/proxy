import {AGENT_PROVIDERS, CUSTOM_AGENT_NAME_MAX, findAgentProvider} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {useLoaderData} from 'react-router';
import {answerAuthorizationRequest, type Consent} from '@/client/oauth-client';
import {AgentLogo} from '@/components/brand-logo';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {cn} from '@proxy/ui/lib/utils';
import {apiMessage} from '@/lib/agent-errors';
import type {ConnectAgentData, connectAgentLoader} from '@/loaders';

// One choice on the page: an agent login the organization has, a new one for a provider without
// one, or a new custom agent, which the person names.
type Choice = {
	key: string;
	providerId: string;
	label: string;
	isNew: boolean;
	detail: string;
	consent: Consent;
};

// Where an MCP client such as Claude, ChatGPT or Poke signs in: the person chooses which of their
// agents it works as, or makes a login for it, and the client gets that agent's access and nothing
// more. Any other MCP client is a custom agent, named after the client unless the person names it
// otherwise. Allowing or denying sends the browser back to the client.
export function ConnectAgentPage() {
	const loaded = useLoaderData<typeof connectAgentLoader>();
	if (loaded.kind === 'error') {
		return (
			<Frame>
				<h1 className="font-medium">This sign-in can’t go on</h1>
				<p className="text-sm text-muted-foreground">{loaded.message}</p>
			</Frame>
		);
	}

	return <Consent request={loaded.request} details={loaded.details} agents={loaded.agents} />;
}

function Frame({children}: {children: ReactNode}) {
	return (
		<div className="flex min-h-dvh w-full items-center justify-center bg-background p-4 text-foreground">
			<div className="grid w-full max-w-sm gap-4">{children}</div>
		</div>
	);
}

function Consent({
	request,
	details,
	agents,
}: Omit<Extract<ConnectAgentData, {kind: 'ok'}>, 'kind'>) {
	const live = agents.filter((agent) => agent.revokedAt === null);
	const choices: Choice[] = [
		...live.map((agent) => ({
			key: agent.id,
			providerId: agent.providerId,
			label: agent.name,
			isNew: false,
			detail: 'Its access as it is',
			consent: {allow: true, agentId: agent.id} as const,
		})),
		...AGENT_PROVIDERS.filter(
			(provider) => provider.custom || !agents.some((agent) => agent.providerId === provider.id),
		).map((provider) => ({
			key: `new-${provider.id}`,
			providerId: provider.id,
			label: provider.name,
			isNew: true,
			detail: 'A new login, with every connection’s defaults',
			consent: {allow: true, providerId: provider.id} as const,
		})),
	];
	// The agent the client's name points at, else the custom agent of that name, else a new one.
	const suggested = details.suggestedProviderId
		? choices.find((choice) => choice.providerId === details.suggestedProviderId)
		: (choices.find((choice) => !choice.isNew && choice.label === details.clientName) ??
			choices.find((choice) => findAgentProvider(choice.providerId)?.custom && choice.isNew));
	const [chosen, setChosen] = useState<string | null>(suggested?.key ?? null);
	const [name, setName] = useState(details.clientName.slice(0, CUSTOM_AGENT_NAME_MAX));
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const answer = async (consent: Consent) => {
		setSending(true);
		const result = await answerAuthorizationRequest(request, consent);
		if (result.isErr()) {
			setSending(false);
			setError(consentErrorMessage(result.error));
			return;
		}
		window.location.assign(result.value.redirectTo);
	};
	const choice = choices.find((candidate) => candidate.key === chosen);
	const naming = choice?.isNew === true && findAgentProvider(choice.providerId)?.custom === true;

	return (
		<Frame>
			<h1 className="font-medium">Connect {details.clientName}</h1>
			<p className="text-sm text-muted-foreground">
				{details.clientName} wants to work as one of your agents over MCP. It can do what that agent
				is allowed, and nothing more; everything it does is in the activity log. It will come back
				to {details.redirectHost}.
			</p>
			<fieldset className="grid gap-1">
				<legend className="mb-2 text-sm">Work as</legend>
				{choices.map((option) => (
					<label
						key={option.key}
						className={cn(
							'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm',
							chosen === option.key ? 'border-primary' : 'border-transparent',
						)}
					>
						<input
							type="radio"
							name="agent"
							value={option.key}
							checked={chosen === option.key}
							onChange={() => setChosen(option.key)}
							className="accent-primary"
						/>
						<AgentLogo providerId={option.providerId} />
						<span className="min-w-0 flex-1 truncate">{option.label}</span>
						<span className="shrink-0 text-muted-foreground">
							{option.isNew ? 'New login' : findAgentProvider(option.providerId)?.company}
						</span>
					</label>
				))}
			</fieldset>
			{choice && <p className="text-sm text-muted-foreground">{choice.detail}.</p>}
			{naming && (
				<div className="grid gap-2">
					<Label htmlFor="agent-name">Name</Label>
					<Input
						id="agent-name"
						autoComplete="off"
						maxLength={CUSTOM_AGENT_NAME_MAX}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex justify-end gap-2">
				<Button variant="outline" disabled={sending} onClick={() => void answer({allow: false})}>
					Deny
				</Button>
				<Button
					disabled={sending || !choice || (naming && name.trim() === '')}
					onClick={() =>
						choice &&
						void answer(
							naming
								? {allow: true, providerId: choice.providerId, name: name.trim()}
								: choice.consent,
						)
					}
				>
					Allow
				</Button>
			</div>
		</Frame>
	);
}

const START_OVER = 'Something went wrong. Start connecting again from the app you came from.';

// A name already taken, or one too long, is the person's to fix here; anything else means starting
// over from the client.
function consentErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && (error.status === 409 || error.status === 400)) {
		return apiMessage(error.body) ?? START_OVER;
	}
	return START_OVER;
}

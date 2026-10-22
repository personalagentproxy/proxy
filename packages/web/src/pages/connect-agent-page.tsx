import {AGENT_PROVIDERS, AGENT_NAME_MAX, findAgentProvider} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {useLoaderData} from 'react-router';
import {listAgents} from '@/client/agents-client';
import {answerAuthorizationRequest, type Consent} from '@/client/oauth-client';
import type {Org} from '@/client/orgs-client';
import {AgentLogo} from '@/components/brand-logo';
import {OrgTile} from '@/components/org-switcher';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {cn} from '@proxy/ui/lib/utils';
import {apiMessage} from '@/lib/agent-errors';
import {forgetPendingAgent} from '@/lib/pending-agent';
import type {AgentLogin} from '@/lib/types';
import type {ConnectAgentData, connectAgentLoader} from '@/loaders';

// One choice on the page: an agent login the organization has, or a new one for a provider, which
// the person names.
type Choice = {
	key: string;
	providerId: string;
	label: string;
	isNew: boolean;
	detail: string;
};

// Where an MCP client such as Claude, ChatGPT or Poke signs in: the person chooses which of their
// agents it works as, in which of their organizations, and the client gets that agent's access and
// nothing more. The agent being set up in this browser is chosen already. A client added without
// setting an agent up first can have a login made for it here, named after its provider, or, for
// a custom agent, after the client, unless the person names it otherwise. Allowing or denying
// sends the browser back to the client.
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

	return (
		<Consent
			request={loaded.request}
			details={loaded.details}
			orgs={loaded.orgs}
			org={loaded.org}
			agents={loaded.agents}
			pendingAgentId={loaded.pendingAgentId}
		/>
	);
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
	orgs,
	org,
	agents: loaded,
	pendingAgentId,
}: Omit<Extract<ConnectAgentData, {kind: 'ok'}>, 'kind'>) {
	// The organization the agent is in, the one the loader started in to start with, and its
	// agents, read again as another is picked.
	const [orgSlug, setOrgSlug] = useState(org);
	const [agents, setAgents] = useState<AgentLogin[]>(loaded);
	const pickOrg = async (slug: string) => {
		setOrgSlug(slug);
		setChosen(null);
		const result = await listAgents(slug);
		setAgents(result.map((answer) => answer.agents).unwrapOr([]));
	};
	const live = agents.filter((agent) => agent.revokedAt === null);
	const choices: Choice[] = [
		...live.map((agent) => ({
			key: agent.id,
			providerId: agent.providerId,
			label: agent.name,
			isNew: false,
			detail: 'Its access as it is',
		})),
		// A product that signs in through another's account, as Claude Duet through Claude, gets a
		// login of that provider's.
		...AGENT_PROVIDERS.filter((provider) => provider.loginProviderId === undefined).map(
			(provider) => ({
				key: `new-${provider.id}`,
				providerId: provider.id,
				label: provider.name,
				isNew: true,
				detail: 'A new login, with every connection’s defaults',
			}),
		),
	];
	// The agent being set up in this browser, else the one the client's name points at, else the
	// custom agent of that name, else a new one.
	const suggested =
		choices.find((choice) => choice.key === pendingAgentId) ??
		(details.suggestedProviderId
			? choices.find((choice) => choice.providerId === details.suggestedProviderId)
			: (choices.find((choice) => !choice.isNew && choice.label === details.clientName) ??
				choices.find((choice) => findAgentProvider(choice.providerId)?.custom && choice.isNew)));
	const [chosen, setChosen] = useState<string | null>(suggested?.key ?? null);
	// The name the person gave a new login, null until they change it.
	const [name, setName] = useState<string | null>(null);
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
		if (consent.allow && 'agentId' in consent) {
			forgetPendingAgent(consent.agentId);
		}
		window.location.assign(result.value.redirectTo);
	};
	const choice = choices.find((candidate) => candidate.key === chosen);
	const naming = choice?.isNew === true;
	const shownName =
		name ??
		(findAgentProvider(choice?.providerId ?? '')?.custom
			? details.clientName.slice(0, AGENT_NAME_MAX)
			: (choice?.label ?? ''));

	return (
		<Frame>
			<h1 className="font-medium">Connect {details.clientName}</h1>
			<p className="text-sm text-muted-foreground">
				{details.clientName} wants to work as one of your agents over MCP. It can do what that agent
				is allowed, and nothing more; everything it does is in the activity log. It will come back
				to {details.redirectHost}.
			</p>
			{orgs.length > 1 && (
				<OrgPicker orgs={orgs} value={orgSlug} onChange={(slug) => void pickOrg(slug)} />
			)}
			<fieldset className="grid gap-1">
				<legend className="pb-2 text-sm">Work as</legend>
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
							onChange={() => {
								setChosen(option.key);
								setName(null);
							}}
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
						maxLength={AGENT_NAME_MAX}
						value={shownName}
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
					disabled={sending || !choice || (naming && shownName.trim() === '')}
					onClick={() =>
						choice &&
						void answer(
							naming
								? {allow: true, org: orgSlug, providerId: choice.providerId, name: shownName.trim()}
								: {allow: true, org: orgSlug, agentId: choice.key},
						)
					}
				>
					Allow
				</Button>
			</div>
		</Frame>
	);
}

// In which of the person's organizations the agent is, where they are in more than one.
function OrgPicker({
	orgs,
	value,
	onChange,
}: {
	orgs: Org[];
	value: string;
	onChange: (slug: string) => void;
}) {
	return (
		<div className="grid gap-2">
			<Label htmlFor="consent-org">In</Label>
			<Select value={value} onValueChange={(slug) => slug && onChange(slug)}>
				<SelectTrigger id="consent-org">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{orgs.map((org) => (
						<SelectItem key={org.id} value={org.slug}>
							<OrgTile org={org} />
							{org.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
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

import {findAgentProvider, type AgentProvider, type AgentProviderId} from '@proxy/integrations';
import {CheckIcon, LoaderCircleIcon} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';
import {useRevalidator} from 'react-router';
import {createAgent, resetAgentPassword} from '@/client/agents-client';
import {AgentProviderTile} from '@/components/agent-provider-tile';
import {CopyButton} from '@/components/copy-button';
import {StepHeading} from '@/components/step-heading';
import {Button} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import {describeFetchError} from '@/lib/loader-utils';
import type {AgentLogin} from '@/lib/types';

// How often the setup asks whether the MCP client has signed in yet.
const POLL_MS = 3000;

// Whether an agent elsewhere on the internet can reach this Personal Agent Proxy: an MCP client
// needs a public https address, and a login's sign-in page is no use to a remote agent otherwise.
const PUBLIC = window.location.protocol === 'https:';

const SELF_HOSTING_URL = 'https://docs.personalagentproxy.com/self-hosting/get-started/';

type Login = {username: string; password: string};

// Which agent, then what that agent needs to work through Personal Agent Proxy: an MCP client
// adds the server and signs in, which makes its login; another is handed a login, made then and
// there when it is chosen. The welcome flow, New agent and setting an agent up again all go
// through here. An agent that has a login already is shown as it is, so arriving here after
// signing in from Claude says Claude is connected. With `fixed`, it is that agent's alone.
export function AgentSetup({
	agents,
	providers,
	fixed,
	continueLabel,
	onContinue,
}: {
	agents: AgentLogin[];
	providers: AgentProvider[];
	fixed?: AgentProviderId;
	continueLabel: string;
	onContinue: (agent: AgentLogin | null) => void;
}) {
	const live = agents.filter((agent) => agent.revokedAt === null);
	const {revalidate} = useRevalidator();
	// The agent already set up, so arriving back here after signing in from Claude shows Claude.
	const [chosenId, setChosenId] = useState<AgentProviderId | null>(
		() =>
			fixed ??
			providers.find((provider) => live.some((agent) => agent.providerId === provider.id))?.id ??
			null,
	);
	const [login, setLogin] = useState<Login | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const chosen = chosenId ? findAgentProvider(chosenId) : undefined;
	const existingFor = (provider: AgentProvider) =>
		live.find((agent) => agent.providerId === provider.id) ?? null;

	const choose = async (provider: AgentProvider) => {
		setChosenId(provider.id);
		setLogin(null);
		setError(null);
		if (provider.connects !== 'login' || existingFor(provider) !== null) {
			return;
		}
		setPending(true);
		const result = await createAgent(provider.id);
		setPending(false);
		if (result.isErr()) {
			setError(describeFetchError(result.error));
			return;
		}
		setLogin({username: result.value.agent.username, password: result.value.password});
		void revalidate();
	};

	const reset = async (agent: AgentLogin) => {
		setPending(true);
		setError(null);
		const result = await resetAgentPassword(agent.id);
		setPending(false);
		if (result.isErr()) {
			setError(describeFetchError(result.error));
			return;
		}
		setLogin({username: agent.username, password: result.value.password});
	};

	if (!chosen) {
		// Over http, only an agent on this computer can reach Personal Agent Proxy: those first,
		// the rest greyed out.
		const choices = PUBLIC
			? providers
			: [...providers].sort((a, b) => Number(b.local) - Number(a.local));
		return (
			<>
				<StepHeading title="Which agent do you use?">
					Personal Agent Proxy gives it your connections and information, with every request it
					makes in the activity log.
				</StepHeading>
				{!PUBLIC && <NotPublicCallout />}
				<div className="grid gap-2 sm:grid-cols-2">
					{choices.map((provider) => {
						const usable = PUBLIC || provider.local;
						return (
							<AgentProviderTile
								key={provider.id}
								provider={provider}
								chosen={false}
								disabled={!usable}
								detail={
									existingFor(provider)
										? 'Connected'
										: usable
											? undefined
											: 'Needs a public https address'
								}
								onChoose={() => void choose(provider)}
							/>
						);
					})}
				</div>
			</>
		);
	}

	const existing = existingFor(chosen);
	const actions = (
		<div className={cn('flex gap-2', fixed ? 'justify-end' : 'justify-between')}>
			{!fixed && (
				<Button variant="outline" disabled={pending} onClick={() => setChosenId(null)}>
					Choose another agent
				</Button>
			)}
			<Button disabled={pending} onClick={() => onContinue(existing)}>
				{continueLabel}
			</Button>
		</div>
	);
	if (chosen.connects === 'mcp') {
		return <McpAgent provider={chosen} existing={existing} actions={actions} />;
	}
	return (
		<LoginAgent
			provider={chosen}
			existing={existing}
			login={login}
			pending={pending}
			error={error}
			actions={actions}
			onReset={() => existing && void reset(existing)}
		/>
	);
}

// What a Personal Agent Proxy on an http address, such as a development machine, is told: only
// an agent on this computer can reach it; the rest need it on a server with a domain.
function NotPublicCallout() {
	return (
		<div className="grid gap-2 rounded-xl border bg-muted/50 p-4 text-sm">
			<p>
				Only an agent on this computer can reach Personal Agent Proxy at{' '}
				<span className="font-mono">{window.location.origin}</span>. The others need a public https
				address.
			</p>
			<p className="text-muted-foreground">
				For those, run Personal Agent Proxy on a server reachable from the internet, such as a VPS,
				and give it a domain name.{' '}
				<a
					href={SELF_HOSTING_URL}
					target="_blank"
					rel="noreferrer"
					className="text-foreground underline underline-offset-4"
				>
					How to set that up
				</a>
			</p>
		</div>
	);
}

// One value to copy, such as the server's address: its label, the value in monospace, and a
// copy button.
function CopyLine({label, value, copyLabel}: {label: string; value: string; copyLabel: string}) {
	return (
		<div className="flex min-w-0 items-center gap-3 rounded-xl border bg-card p-4 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate font-mono">{value}</span>
			<CopyButton value={value} label={copyLabel} />
		</div>
	);
}

// Where each MCP client keeps its connectors, as the docs describe it; Claude Code takes a command
// instead, run in a terminal with the server's address.
const MCP_STEPS: Record<
	string,
	{where: string; url?: string; command?: (serverUrl: string) => string}
> = {
	claude: {
		where: 'In Claude, open Settings, then Connectors, and choose Add custom connector.',
		url: 'https://claude.ai/settings/connectors',
	},
	'claude-code': {
		where: 'Run the command above in a terminal.',
		command: (serverUrl) => `claude mcp add --transport http personal-agent-proxy ${serverUrl}`,
	},
	'claude-desktop': {
		where: 'In Claude Desktop, open Settings, then Connectors, and choose Add custom connector.',
	},
	chatgpt: {
		where:
			'In ChatGPT, open Settings, then Apps & Connectors, turn on Developer mode under Advanced, and create a connector.',
	},
	poke: {
		where:
			'On poke.com, under Integrations, add a new one: a name and the address, with the API key left empty.',
		url: 'https://poke.com/integrations/new',
	},
};

// The server's address to add, and a wait for the client to sign in: when it has, the login it
// made is here. An MCP client reaches the server over the internet, at an https address, so a
// server that isn't one, such as a development machine, is told to move first.
function McpAgent({
	provider,
	existing,
	actions,
}: {
	provider: AgentProvider;
	existing: AgentLogin | null;
	actions: ReactNode;
}) {
	const serverUrl = `${window.location.origin}/mcp`;
	const reachable = PUBLIC || provider.local;
	const steps = MCP_STEPS[provider.id];
	const command = steps?.command?.(serverUrl);
	const {revalidate} = useRevalidator();
	const connected = existing !== null;

	useEffect(() => {
		if (connected || !reachable) {
			return;
		}
		const timer = setInterval(() => void revalidate(), POLL_MS);
		return () => clearInterval(timer);
	}, [connected, reachable, revalidate]);

	return (
		<>
			<StepHeading title={`Add Personal Agent Proxy to ${provider.name}`}>
				{provider.name} works through Personal Agent Proxy as a connector, signed in with its own
				login.
			</StepHeading>
			{!reachable && <NotPublicCallout />}
			{command ? (
				<CopyLine label="Command" value={command} copyLabel="Copy command" />
			) : (
				<CopyLine label="Server" value={serverUrl} copyLabel="Copy server address" />
			)}
			<ol className="grid list-decimal gap-2 pl-5 text-sm">
				<li>
					{steps?.where ?? `In ${provider.name}, add a custom connector.`}{' '}
					{steps?.url && (
						<a
							href={steps.url}
							target="_blank"
							rel="noreferrer"
							className="underline underline-offset-4"
						>
							Open {provider.name}
						</a>
					)}
				</li>
				<li>
					{command
						? `In ${provider.name}, run /mcp and choose personal-agent-proxy to sign in.`
						: 'Paste the server address and add it.'}
				</li>
				<li>
					{provider.name} opens Personal Agent Proxy to sign in. Choose {provider.name} when asked
					which agent it works as.
				</li>
			</ol>
			{reachable && (
				<p className="flex items-center gap-2 text-sm text-muted-foreground">
					{connected ? (
						<>
							<CheckIcon className="size-4" />
							{provider.name} is signed in as {existing.name}.
						</>
					) : (
						<>
							<LoaderCircleIcon className="size-4 animate-spin" />
							Waiting for {provider.name} to sign in…
						</>
					)}
				</p>
			)}
			{actions}
		</>
	);
}

// The login, handed to the agent the way it takes one: as a message, or through its vault. One
// that exists already keeps its password, unless a new one is asked for here.
function LoginAgent({
	provider,
	existing,
	login,
	pending,
	error,
	actions,
	onReset,
}: {
	provider: AgentProvider;
	existing: AgentLogin | null;
	login: Login | null;
	pending: boolean;
	error: string | null;
	actions: ReactNode;
	onReset: () => void;
}) {
	return (
		<>
			{provider.vault ? (
				<StepHeading title={`Put ${provider.name}'s login in its vault`}>
					{provider.name} signs in to Personal Agent Proxy with a login of its own, kept in its
					vault rather than in your chat.
				</StepHeading>
			) : (
				<StepHeading title={`Hand ${provider.name} its login`}>
					{provider.name} signs in to Personal Agent Proxy with a login of its own. Send it this
					message, and it can get started.
				</StepHeading>
			)}
			{login && provider.vault && <VaultHandover provider={provider} login={login} />}
			{login && !provider.vault && <HandoverMessage login={login} />}
			{!login && (
				<div className="grid gap-3 rounded-xl border bg-card p-4 text-sm">
					{pending && (
						<p className="flex items-center gap-2 text-muted-foreground">
							<LoaderCircleIcon className="size-4 animate-spin" />
							Making the login…
						</p>
					)}
					{!pending && existing && (
						<>
							<p className="text-muted-foreground">
								{provider.name} already has a login, {existing.username}. Its password was shown
								once, when it was made. To hand it over again, make a new one; the current one stops
								working at once.
							</p>
							<Button variant="outline" className="justify-self-start" onClick={onReset}>
								New password
							</Button>
						</>
					)}
					{!pending && !existing && !error && (
						<p className="text-muted-foreground">The login could not be made.</p>
					)}
				</div>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{actions}
		</>
	);
}

// The message to paste to the agent: the sign-in page and the login, shown this once.
function HandoverMessage({login}: {login: Login}) {
	const signInUrl = `${window.location.origin}/agent/login`;
	const message = [
		'Here is my Personal Agent Proxy login. It holds my connections and personal information; sign in with it when a task needs them.',
		'',
		`Sign-in page: ${signInUrl}`,
		`Username: ${login.username}`,
		`Password: ${login.password}`,
	].join('\n');

	return (
		<Message value={message} copyLabel="Copy message">
			The password is not shown again once you leave this page.
		</Message>
	);
}

// An agent that keeps passwords in a vault won't take one in chat: it is asked for a link to its
// vault, the login is filled in on the page it sends, and then it is told to sign in.
function VaultHandover({provider, login}: {provider: AgentProvider; login: Login}) {
	const signInUrl = `${window.location.origin}/agent/login`;
	const ask = `Please send me a setup link for a secure vault entry, for my Personal Agent Proxy login at ${signInUrl} with the username ${login.username}.`;
	const done = `Setup done. Please sign in to Personal Agent Proxy at ${signInUrl} and look around. Personal Agent Proxy holds many (frequently changing) connections to third-party apps that might be useful to you to achieve tasks. Check there first if you need a tool that you don't have direct access to.`;

	return (
		<ol className="grid gap-4 text-sm">
			<VaultStep number={1} title={`Ask ${provider.name} for a vault link`}>
				<Message value={ask} copyLabel="Copy message" />
			</VaultStep>
			<VaultStep number={2} title="Enter the login on the page it sends">
				<div className="grid gap-2 rounded-xl border bg-card p-4">
					<LoginLine label="Sign-in page" value={signInUrl} copyLabel="Copy sign-in page" />
					<LoginLine label="Username" value={login.username} copyLabel="Copy username" />
					<LoginLine label="Password" value={login.password} copyLabel="Copy password" />
					<p className="text-muted-foreground">
						The password is not shown again once you leave this page.
					</p>
				</div>
			</VaultStep>
			<VaultStep number={3} title={`Tell ${provider.name} it is set up`}>
				<Message value={done} copyLabel="Copy message" />
			</VaultStep>
		</ol>
	);
}

function VaultStep({
	number,
	title,
	children,
}: {
	number: number;
	title: string;
	children: ReactNode;
}) {
	return (
		<li className="grid gap-2">
			<p>
				<span className="text-muted-foreground">{number}.</span> {title}
			</p>
			{children}
		</li>
	);
}

// A message to paste to the agent, with a copy button and what to know about it.
function Message({
	value,
	copyLabel,
	children,
}: {
	value: string;
	copyLabel: string;
	children?: ReactNode;
}) {
	if (!children) {
		return (
			<div className="flex items-start gap-3 rounded-xl border bg-card p-4">
				<pre className="min-w-0 flex-1 font-sans text-sm whitespace-pre-wrap">{value}</pre>
				<CopyButton value={value} label={copyLabel} />
			</div>
		);
	}

	return (
		<div className="grid gap-3 rounded-xl border bg-card p-4">
			<pre className="font-sans text-sm whitespace-pre-wrap">{value}</pre>
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">{children}</p>
				<CopyButton value={value} label={copyLabel} />
			</div>
		</div>
	);
}

// One value of the login, to copy into the agent's vault.
function LoginLine({label, value, copyLabel}: {label: string; value: string; copyLabel: string}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate font-mono">{value}</span>
			<CopyButton value={value} label={copyLabel} />
		</div>
	);
}

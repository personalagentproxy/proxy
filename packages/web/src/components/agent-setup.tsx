import {
	AGENT_NAME_MAX,
	AGENT_PROVIDERS,
	findAgentProvider,
	type AgentProvider,
	type AgentProviderId,
} from '@proxy/integrations';
import {CheckIcon, LoaderCircleIcon} from 'lucide-react';
import {useEffect, useState, type FormEvent, type ReactNode} from 'react';
import {useRevalidator, useSearchParams} from 'react-router';
import {
	createAgent,
	listMcpClients,
	resetAgentPassword,
	type McpClient,
} from '@/client/agents-client';
import {AgentProviderTile} from '@/components/agent-provider-tile';
import {CopyButton} from '@/components/copy-button';
import {StepHeading} from '@/components/step-heading';
import {Button} from '@proxy/ui/components/button';
import {Card} from '@proxy/ui/components/card';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {describeFetchError} from '@/lib/loader-utils';
import {forgetPendingAgent, rememberPendingAgent} from '@/lib/pending-agent';
import type {AgentLogin} from '@/lib/types';
import {useCommandEnter} from '@/hooks/use-command-enter';
import {useOrgSlug} from '@/hooks/use-org';

// How often the setup asks whether the MCP client has signed in yet.
const POLL_MS = 3000;

// Whether an agent elsewhere on the internet can reach this Personal Agent Proxy: an MCP client
// needs a public https address, and a login's sign-in page is no use to a remote agent otherwise.
const PUBLIC = window.location.protocol === 'https:';

const SELF_HOSTING_URL = 'https://docs.personalagentproxy.com/self-hosting/get-started/';

type Login = {username: string; password: string};

// Adding an agent, in the welcome flow and on New agent: which kind of agent, its name, which
// makes its login, then what that agent needs to work through Personal Agent Proxy. Each step is
// in the address (`?provider=claude`, then `?agent=<id>`), so the browser's back button returns to
// the choice, and a reload stays on the agent being set up. There can be any number of agents of
// a kind, each made here on purpose.
export function AddAgent({
	agents,
	shared = false,
	continueLabel,
	onContinue,
}: {
	// The organization's agents, among which the one being set up is found again after a reload.
	agents: AgentLogin[];
	// A new agent is every member's rather than the person's own.
	shared?: boolean;
	continueLabel: string;
	onContinue: (agent: AgentLogin) => void;
}) {
	const [params, setParams] = useSearchParams();
	const {revalidate} = useRevalidator();
	// The agent made here, with its password, shown this once.
	const [made, setMade] = useState<{agent: AgentLogin; password: string} | null>(null);
	const agentId = params.get('agent');
	const agent =
		made && made.agent.id === agentId
			? made.agent
			: agents.find((candidate) => candidate.id === agentId);
	const provider = findAgentProvider(params.get('provider') ?? '');
	const show = (step: {provider?: string; agent?: string}, replace = false) =>
		setParams(
			(current) => {
				current.delete('provider');
				current.delete('agent');
				for (const [key, value] of Object.entries(step)) {
					current.set(key, value);
				}
				return current;
			},
			{replace},
		);
	const chooseAnother = (
		<Button variant="outline" onClick={() => show({})}>
			Choose another agent
		</Button>
	);

	if (agent) {
		return (
			<AgentSetup
				agent={agent}
				password={made?.agent.id === agent.id ? made.password : undefined}
				back={chooseAnother}
				continueLabel={continueLabel}
				onContinue={() => onContinue(agent)}
			/>
		);
	}
	if (provider) {
		return (
			<NameAgent
				provider={provider}
				shared={shared}
				back={chooseAnother}
				onMade={(next) => {
					setMade(next);
					// Back from the setup returns to the choice, not to making another.
					show({agent: next.agent.id}, true);
					void revalidate();
				}}
			/>
		);
	}
	return <AgentPicker onChoose={(next) => show({provider: next.id})} />;
}

// Which kind of agent. Over http, only an agent on this computer can reach Personal Agent Proxy:
// those first, the rest greyed out.
function AgentPicker({onChoose}: {onChoose: (provider: AgentProvider) => void}) {
	const choices = PUBLIC
		? AGENT_PROVIDERS
		: [...AGENT_PROVIDERS].sort((a, b) => Number(b.local) - Number(a.local));
	return (
		<>
			<StepHeading title="Which agent do you use?">
				Personal Agent Proxy gives it your connections and information, with every request it makes
				in the activity log.
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
								provider.custom
									? 'Any agent that speaks MCP'
									: usable
										? undefined
										: 'Needs a public https address'
							}
							onChoose={() => onChoose(provider)}
						/>
					);
				})}
			</div>
		</>
	);
}

// The new agent's name, its provider's to start with, and making it: its login is made then.
function NameAgent({
	provider,
	shared,
	back,
	onMade,
}: {
	provider: AgentProvider;
	shared: boolean;
	back: ReactNode;
	onMade: (made: {agent: AgentLogin; password: string}) => void;
}) {
	const org = useOrgSlug();
	const [name, setName] = useState(provider.custom ? '' : provider.name);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ready = name.trim() !== '' && !pending;

	const make = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready) {
			return;
		}
		setPending(true);
		setError(null);
		const result = await createAgent(org, provider.id, {name: name.trim(), shared});
		setPending(false);
		if (result.isErr()) {
			setError(describeFetchError(result.error));
			return;
		}
		onMade(result.value);
	};

	return (
		<form className="grid gap-4" onSubmit={(event) => void make(event)}>
			<StepHeading title={provider.custom ? 'Name your agent' : `Name this ${provider.name}`}>
				What it is called here and in the activity log, to tell it apart from your other agents. You
				can change it later.
			</StepHeading>
			<div className="grid gap-2">
				<Label htmlFor="agent-name">Name</Label>
				<Input
					id="agent-name"
					autoFocus
					autoComplete="off"
					maxLength={AGENT_NAME_MAX}
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex justify-between gap-2">
				{back}
				<Button type="submit" disabled={!ready}>
					{pending ? 'Making…' : 'Continue'}
				</Button>
			</div>
		</form>
	);
}

// What one agent needs to work through Personal Agent Proxy: an MCP client adds the server and
// signs in as it; another is handed its login, with `password` when it was just made, or a new
// password otherwise. Setting an agent up again goes through here too.
export function AgentSetup({
	agent,
	password,
	back,
	continueLabel,
	onContinue,
}: {
	agent: AgentLogin;
	password?: string;
	back?: ReactNode;
	continueLabel: string;
	onContinue: () => void;
}) {
	const provider = findAgentProvider(agent.providerId);
	useCommandEnter(onContinue, provider !== undefined);
	if (!provider) {
		return null;
	}

	const actions = (
		<div className={back ? 'flex justify-between gap-2' : 'flex justify-end gap-2'}>
			{back}
			<Button onClick={onContinue}>{continueLabel}</Button>
		</div>
	);
	if (provider.connects === 'mcp') {
		return <McpAgent provider={provider} agent={agent} actions={actions} />;
	}
	return (
		<LoginAgent
			provider={provider}
			agent={agent}
			initial={password ? {username: agent.username, password} : null}
			actions={actions}
		/>
	);
}

// What a Personal Agent Proxy on an http address, such as a development machine, is told: only
// an agent on this computer can reach it; the rest need it on a server with a domain. A custom
// agent could be either, so it is warned that the address works only for one on this computer.
function NotPublicCallout({custom = false}: {custom?: boolean}) {
	return (
		<Card className="grid gap-2 bg-muted/50 text-sm">
			{custom ? (
				<p>
					This server address only works for an agent on this computer: Personal Agent Proxy is at{' '}
					<span className="font-mono">{window.location.origin}</span>, which nothing elsewhere can
					reach. An agent that runs on its company's servers, as most do, needs a public https
					address.
				</p>
			) : (
				<p>
					Only an agent on this computer can reach Personal Agent Proxy at{' '}
					<span className="font-mono">{window.location.origin}</span>. The others need a public
					https address.
				</p>
			)}
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
		</Card>
	);
}

// One value to copy, such as the server's address: its label, the value in monospace, and a
// copy button.
function CopyLine({label, value, copyLabel}: {label: string; value: string; copyLabel: string}) {
	return (
		<Card className="flex min-w-0 items-center gap-3 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate font-mono">{value}</span>
			<CopyButton value={value} label={copyLabel} />
		</Card>
	);
}

// Where each MCP client keeps its connectors, as the docs describe it; command-based clients take
// a command to run in a terminal with the server's address instead.
const MCP_STEPS: Partial<
	Record<
		AgentProviderId,
		{
			where: string;
			url?: string;
			openLabel?: string;
			command?: (serverUrl: string) => string;
			afterAdd?: string;
			// What to do on the sign-in page, for the agent named `name`.
			authorize?: (name: string) => string;
		}
	>
> = {
	claude: {
		where:
			'In Claude, open Customize, then Connectors, and choose Add custom connector. Claude Duet uses the same connectors as Claude.',
		url: 'https://claude.ai/customize/connectors',
		openLabel: 'Claude',
		afterAdd:
			'Name the connector, paste the server address, and continue. Choose Sign in now, then choose Register automatically under OAuth client.',
		authorize: (name) =>
			`Claude opens Personal Agent Proxy to sign in. Allow it to work as ${name}. That login gives Claude and Claude Duet the same access and activity history.`,
	},
	'claude-code': {
		where: 'Run the command above in a terminal.',
		command: (serverUrl) => `claude mcp add --transport http personal-agent-proxy ${serverUrl}`,
	},
	'claude-desktop': {
		where: 'In Claude Desktop, open Settings, then Connectors, and choose Add custom connector.',
	},
	hermes: {
		where: 'Run the command above in a terminal.',
		command: (serverUrl) =>
			`hermes mcp add personal-agent-proxy --url '${serverUrl}' --auth oauth --connect-timeout 300`,
		afterAdd: 'Hermes Agent opens a browser when it can, or prints a sign-in link.',
		authorize: (name) =>
			`In the browser, sign in and allow it to work as ${name}. If Hermes Agent is on a remote host, copy the full redirect URL from the browser back into its prompt.`,
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
	custom: {
		where:
			'In your agent, add a custom connector or remote MCP server, as it calls them, over Streamable HTTP.',
		afterAdd:
			'Paste the server address and add it. It signs in with OAuth, so leave any API key or token empty.',
		authorize: (name) =>
			`Your agent opens Personal Agent Proxy to sign in. Allow it to work as ${name}.`,
	},
};

// The server's address to add, and a wait for the client to sign in as the agent, which the
// sign-in page has chosen already when it opens in this browser. An MCP client reaches the server
// over the internet, at an https address, so a server that isn't one, such as a development
// machine, is told to move first.
function McpAgent({
	provider,
	agent,
	actions,
}: {
	provider: AgentProvider;
	agent: AgentLogin;
	actions: ReactNode;
}) {
	const org = useOrgSlug();
	// A custom agent is the person's to name, so it is called that; any other by its app.
	const app = provider.custom ? agent.name : provider.name;
	const serverUrl = `${window.location.origin}/mcp`;
	const reachable = PUBLIC || provider.local;
	const steps = MCP_STEPS[provider.id];
	const command = steps?.command?.(serverUrl);
	const clients = useMcpClients(org, agent.id, reachable);
	const signedIn = clients?.[0] ?? null;

	useEffect(() => {
		if (signedIn) {
			forgetPendingAgent(agent.id);
			return;
		}
		rememberPendingAgent({org, agentId: agent.id});
	}, [org, agent.id, signedIn]);

	return (
		<>
			<StepHeading title={`Add Personal Agent Proxy to ${app}`}>
				{app} works through Personal Agent Proxy as a connector, signed in as {agent.name}.
			</StepHeading>
			{!reachable && <NotPublicCallout />}
			{!PUBLIC && provider.custom && <NotPublicCallout custom />}
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
							Open {steps.openLabel ?? provider.name}
						</a>
					)}
				</li>
				<li>
					{steps?.afterAdd ??
						(command
							? `In ${provider.name}, run /mcp and choose personal-agent-proxy to sign in.`
							: 'Paste the server address and add it.')}
				</li>
				<li>
					{steps?.authorize?.(agent.name) ??
						`${provider.name} opens Personal Agent Proxy to sign in. Allow it to work as ${agent.name}.`}
				</li>
			</ol>
			{reachable && (
				<p className="flex items-center gap-2 text-sm text-muted-foreground">
					{signedIn ? (
						<>
							<CheckIcon className="size-4" />
							{signedIn.name} is signed in as {agent.name}.
						</>
					) : (
						<>
							<LoaderCircleIcon className="size-4 animate-spin" />
							Waiting for {app} to sign in…
						</>
					)}
				</p>
			)}
			{actions}
		</>
	);
}

// The MCP clients signed in as the agent, asked for until one is; null until first known.
function useMcpClients(org: string, agentId: string, asking: boolean): McpClient[] | null {
	const [clients, setClients] = useState<McpClient[] | null>(null);
	const signedIn = clients !== null && clients.length > 0;

	useEffect(() => {
		if (!asking || signedIn) {
			return;
		}
		let stopped = false;
		const ask = async () => {
			const result = await listMcpClients(org, agentId);
			if (stopped || result.isErr()) {
				return;
			}
			setClients(result.value.clients);
		};
		void ask();
		const timer = setInterval(() => void ask(), POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [org, agentId, asking, signedIn]);

	return clients;
}

// The login, handed to the agent the way it takes one: as a message, or through its vault. Its
// password is shown once, when it is made, unless a new one is asked for here.
function LoginAgent({
	provider,
	agent,
	initial,
	actions,
}: {
	provider: AgentProvider;
	agent: AgentLogin;
	initial: Login | null;
	actions: ReactNode;
}) {
	const org = useOrgSlug();
	const [login, setLogin] = useState<Login | null>(initial);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reset = async () => {
		setPending(true);
		setError(null);
		const result = await resetAgentPassword(org, agent.id);
		setPending(false);
		if (result.isErr()) {
			setError(describeFetchError(result.error));
			return;
		}
		setLogin({username: agent.username, password: result.value.password});
	};

	return (
		<>
			{provider.vault ? (
				<StepHeading title={`Put ${agent.name}'s login in its vault`}>
					{provider.name} signs in to Personal Agent Proxy with a login of its own, kept in its
					vault rather than in your chat.
				</StepHeading>
			) : (
				<StepHeading title={`Hand ${agent.name} its login`}>
					{provider.name} signs in to Personal Agent Proxy with a login of its own. Send it this
					message, and it can get started.
				</StepHeading>
			)}
			{login && provider.vault && <VaultHandover provider={provider} login={login} />}
			{login && !provider.vault && <HandoverMessage login={login} />}
			{!login && (
				<Card className="grid gap-3 text-sm">
					<p className="text-muted-foreground">
						{agent.name}&apos;s login is {agent.username}. Its password was shown once, when it was
						made. To hand it over again, make a new one; the current one stops working at once.
					</p>
					<Button
						variant="outline"
						className="justify-self-start"
						disabled={pending}
						onClick={() => void reset()}
					>
						{pending ? 'Making…' : 'New password'}
					</Button>
				</Card>
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
				<Card className="grid gap-2">
					<LoginLine label="Sign-in page" value={signInUrl} copyLabel="Copy sign-in page" />
					<LoginLine label="Username" value={login.username} copyLabel="Copy username" />
					<LoginLine label="Password" value={login.password} copyLabel="Copy password" />
					<p className="text-muted-foreground">
						The password is not shown again once you leave this page.
					</p>
				</Card>
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
			<Card className="flex items-start gap-3">
				<pre className="min-w-0 flex-1 font-sans text-sm whitespace-pre-wrap">{value}</pre>
				<CopyButton value={value} label={copyLabel} />
			</Card>
		);
	}

	return (
		<Card className="grid gap-3">
			<pre className="font-sans text-sm whitespace-pre-wrap">{value}</pre>
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">{children}</p>
				<CopyButton value={value} label={copyLabel} />
			</div>
		</Card>
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

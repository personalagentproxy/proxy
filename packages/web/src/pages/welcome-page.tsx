import {
	AGENT_PROVIDERS,
	findAgentProvider,
	type Action,
	type AgentProvider,
	type AgentProviderId,
} from '@proxy/integrations';
import {CheckIcon, LoaderCircleIcon} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {createAgent, resetAgentPassword} from '@/client/agents-client';
import {setConnectionDefaults} from '@/client/connections-client';
import {finishOnboarding} from '@/client/me-client';
import {AgentProviderTile} from '@/components/agent-provider-tile';
import {ConnectEmailForm} from '@/components/connect-email-form';
import {ConnectionAccess} from '@/components/connection-access';
import {CopyButton} from '@/components/copy-button';
import {IntegrationCatalog} from '@/components/integration-catalog';
import {SuccessLine} from '@/components/success-line';
import {Button} from '@proxy/ui/components/button';
import {defaultActions, defaultsOnOrOff, integrationOf} from '@/lib/access';
import {signInFailedMessage} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
import type {AgentLogin, Connection} from '@/lib/types';
import type {welcomeConnectionLoader, welcomeLoader} from '@/loaders';

// How often the agent step asks whether the MCP client has signed in yet.
const POLL_MS = 3000;

// Step one is the agent; the rest are step two: the catalog, the mailbox form, and (on its own
// page, `WelcomeConnectionPage`) a new connection's permissions.
type Step = 'agent' | 'connections' | 'email';

// Whether an agent elsewhere on the internet can reach this Personal Agent Proxy: an MCP client
// needs a public https address, and a login's sign-in page is no use to a remote agent otherwise.
const PUBLIC = window.location.protocol === 'https:';

const SELF_HOSTING_URL = 'https://docs.personalagentproxy.com/self-hosting/get-started/';

// The welcome flow, before the app: step one connects the person's agent, in the way that agent
// takes (an MCP client adds the server and signs in; another is handed a login), step two their
// services, each connection's permissions confirmed as it is made. Done, or skipped, it is not
// shown again.
export function WelcomePage({step}: {step: Step}) {
	const {agents, connections} = useLoaderData<typeof welcomeLoader>();
	const navigate = useNavigate();
	const [finishing, setFinishing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const agentName = agentNameOf(agents);

	const finish = async () => {
		setFinishing(true);
		const result = await finishOnboarding();
		if (result.isErr()) {
			setFinishing(false);
			setError(describeFetchError(result.error));
			return;
		}
		navigate('/connections');
	};

	return (
		<Frame step={step === 'agent' ? 1 : 2}>
			{step === 'agent' && (
				<AgentStep agents={agents} onContinue={() => navigate('/welcome/connections')} />
			)}
			{step === 'connections' && (
				<ConnectionsStep
					agentName={agentName}
					connections={connections}
					finishing={finishing}
					onDone={() => void finish()}
				/>
			)}
			{step === 'email' && (
				<EmailStep onContinue={(connection) => navigate(`/welcome/connections/${connection.id}`)} />
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{step === 'agent' && (
				<button
					type="button"
					disabled={finishing}
					className="justify-self-start text-sm text-muted-foreground underline underline-offset-4"
					onClick={() => void finish()}
				>
					Skip setup
				</button>
			)}
		</Frame>
	);
}

// A connection just made in the flow: what the agent may do with it, confirmed before going on.
export function WelcomeConnectionPage() {
	const {agents, connection} = useLoaderData<typeof welcomeConnectionLoader>();
	const integration = connection && integrationOf(connection);
	if (!connection || !integration) {
		return (
			<Frame step={2}>
				<p className="text-sm text-muted-foreground">This connection does not exist.</p>
				<Button
					variant="outline"
					className="justify-self-start"
					nativeButton={false}
					render={<Link to="/welcome/connections" />}
				>
					Back
				</Button>
			</Frame>
		);
	}

	return (
		<Frame step={2}>
			<ConnectionStep
				agentName={agentNameOf(agents)}
				connection={connection}
				actions={integration.actions}
			/>
		</Frame>
	);
}

// The agent the flow is for: the first login made, else a stand-in.
function agentNameOf(agents: AgentLogin[]): string {
	return agents.find((agent) => agent.revokedAt === null)?.name ?? 'your agent';
}

function Frame({step, children}: {step: 1 | 2; children: ReactNode}) {
	return (
		<div className="flex min-h-dvh w-full justify-center bg-background p-4 pt-[12vh] text-foreground">
			<div className="grid w-full max-w-lg content-start gap-4">
				<p className="text-sm text-muted-foreground">Step {step} of 2</p>
				{children}
			</div>
		</div>
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

function Heading({title, children}: {title: string; children?: ReactNode}) {
	return (
		<div className="grid gap-1">
			<h1 className="font-medium">{title}</h1>
			{children && <p className="text-sm text-muted-foreground">{children}</p>}
		</div>
	);
}

type Login = {username: string; password: string};

// Which agent, then what that agent needs. Choosing one that is handed a login makes the login
// then and there. An agent that has a login already is shown as it is, so arriving here after
// signing in from Claude says Claude is connected.
function AgentStep({agents, onContinue}: {agents: AgentLogin[]; onContinue: () => void}) {
	const live = agents.filter((agent) => agent.revokedAt === null);
	const {revalidate} = useRevalidator();
	const [chosenId, setChosenId] = useState<AgentProviderId | null>(
		() => findAgentProvider(live[0]?.providerId ?? '')?.id ?? null,
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
		const providers = PUBLIC
			? AGENT_PROVIDERS
			: [...AGENT_PROVIDERS].sort((a, b) => Number(b.local) - Number(a.local));
		return (
			<>
				<Heading title="Which agent do you use?">
					Personal Agent Proxy gives it your connections and information, with every request it
					makes in the activity log.
				</Heading>
				{!PUBLIC && <NotPublicCallout />}
				<div className="grid gap-2 sm:grid-cols-2">
					{providers.map((provider) => {
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
	const another = (
		<Button variant="outline" disabled={pending} onClick={() => setChosenId(null)}>
			Choose another agent
		</Button>
	);
	if (chosen.connects === 'mcp') {
		return (
			<McpAgent provider={chosen} existing={existing} another={another} onContinue={onContinue} />
		);
	}
	return (
		<LoginAgent
			provider={chosen}
			existing={existing}
			login={login}
			pending={pending}
			error={error}
			another={another}
			onReset={() => existing && void reset(existing)}
			onContinue={onContinue}
		/>
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
	another,
	onContinue,
}: {
	provider: AgentProvider;
	existing: AgentLogin | null;
	another: ReactNode;
	onContinue: () => void;
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
			<Heading title={`Add Personal Agent Proxy to ${provider.name}`}>
				{provider.name} works through Personal Agent Proxy as a connector, signed in with its own
				login.
			</Heading>
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
			<div className="flex justify-between gap-2">
				{another}
				<Button onClick={onContinue}>Continue</Button>
			</div>
		</>
	);
}

// The login, as a message to hand the agent. One that exists already keeps its password, unless
// a new one is asked for here.
function LoginAgent({
	provider,
	existing,
	login,
	pending,
	error,
	another,
	onReset,
	onContinue,
}: {
	provider: AgentProvider;
	existing: AgentLogin | null;
	login: Login | null;
	pending: boolean;
	error: string | null;
	another: ReactNode;
	onReset: () => void;
	onContinue: () => void;
}) {
	return (
		<>
			<Heading title={`Hand ${provider.name} its login`}>
				{provider.name} signs in to Personal Agent Proxy with a login of its own. Send it this
				message, and it can get started.
			</Heading>
			{login ? (
				<HandoverMessage login={login} />
			) : (
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
								when it was made; if it is lost, make a new one.
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
			<div className="flex justify-between gap-2">
				{another}
				<Button disabled={pending} onClick={onContinue}>
					Continue
				</Button>
			</div>
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
		<div className="grid gap-3 rounded-xl border bg-card p-4">
			<pre className="font-sans text-sm whitespace-pre-wrap">{message}</pre>
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-muted-foreground">
					The password is not shown again once you leave this page.
				</p>
				<CopyButton value={message} label="Copy message" />
			</div>
		</div>
	);
}

// The catalog: a plus per integration, and how many accounts of it are connected. A mailbox goes
// to the form; a sign-in starts at the api and comes back to the connection's page here.
function ConnectionsStep({
	agentName,
	connections,
	finishing,
	onDone,
}: {
	agentName: string;
	connections: Connection[];
	finishing: boolean;
	onDone: () => void;
}) {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const failed = signInFailedMessage(params.get('error'));
	const connected = connections.filter((connection) => connection.integrationId !== 'info');

	return (
		<>
			<Heading title="Connect your services">
				Add an account, then choose what {agentName} may do with it. The rest can be connected
				later.
			</Heading>
			{failed && <p className="text-sm text-destructive">{failed}</p>}
			<IntegrationCatalog
				connections={connections}
				returnTo="welcome"
				onConnectEmail={() => navigate('/welcome/connections/email')}
			/>
			<div className="flex justify-between gap-2">
				<Button variant="outline" nativeButton={false} render={<Link to="/welcome" />}>
					Back
				</Button>
				<Button disabled={finishing} onClick={onDone}>
					{connected.length === 0 ? 'Skip for now' : 'Finish'}
				</Button>
			</div>
		</>
	);
}

// The mailbox form. Test connection signs in without saving; Continue makes the connection and
// goes on to its permissions.
function EmailStep({onContinue}: {onContinue: (connection: Connection) => void}) {
	return (
		<>
			<Heading title="Connect a mailbox">
				Personal Agent Proxy signs in with an app password, made for Personal Agent Proxy alone in
				your mail account. Revoking it there disconnects Personal Agent Proxy.
			</Heading>
			<ConnectEmailForm
				cancel={
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link to="/welcome/connections" />}
					>
						Back
					</Button>
				}
				continueLabel="Continue"
				onConnected={onContinue}
			/>
		</>
	);
}

// A new connection's permissions: one checkbox per action, saved as the connection's defaults as
// they are ticked, and Confirm back to the catalog.
function ConnectionStep({
	agentName,
	connection,
	actions,
}: {
	agentName: string;
	connection: Connection;
	actions: Action[];
}) {
	const navigate = useNavigate();
	const {revalidate} = useRevalidator();
	const [error, setError] = useState<string | null>(null);
	const defaults = defaultActions(connection);

	return (
		<>
			<Heading title={`What can ${agentName} do with ${connection.account}?`}>
				Every agent gets what is ticked here unless its own page says otherwise. You can change it
				any time on the connection's page.
			</Heading>
			<SuccessLine>Connection added successfully</SuccessLine>
			<div className="rounded-xl border bg-card px-1 py-1">
				<ConnectionAccess
					actions={actions}
					defaults={defaults}
					onChange={async (changes) => {
						const result = await setConnectionDefaults(connection.id, defaultsOnOrOff(changes));
						setError(result.isErr() ? describeFetchError(result.error) : null);
						await revalidate();
					}}
				/>
			</div>
			{defaults.length === 0 && (
				<p className="text-sm text-muted-foreground">
					Nothing is ticked, so {agentName} can't use this account yet.
				</p>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex justify-end">
				<Button onClick={() => navigate('/welcome/connections')}>Confirm</Button>
			</div>
		</>
	);
}

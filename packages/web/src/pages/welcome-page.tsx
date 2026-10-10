import {AGENT_PROVIDERS, type Action} from '@proxy/integrations';
import {useState, type ReactNode} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {setConnectionDefaults} from '@/client/connections-client';
import {finishOnboarding} from '@/client/me-client';
import {AgentSetup} from '@/components/agent-setup';
import {ConnectEmailForm} from '@/components/connect-email-form';
import {ConnectionAccess} from '@/components/connection-access';
import {IntegrationCatalog} from '@/components/integration-catalog';
import {StepHeading} from '@/components/step-heading';
import {SuccessLine} from '@/components/success-line';
import {Button} from '@proxy/ui/components/button';
import {defaultActions, defaultsOnOrOff, integrationOf} from '@/lib/access';
import {signInFailedMessage} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
import type {AgentLogin, Connection} from '@/lib/types';
import type {welcomeConnectionLoader, welcomeLoader} from '@/loaders';

// Step one is the agent; the rest are step two: the catalog, the mailbox form, and (on its own
// page, `WelcomeConnectionPage`) a new connection's permissions.
type Step = 'agent' | 'connections' | 'email';

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
				<AgentSetup
					agents={agents}
					providers={AGENT_PROVIDERS}
					continueLabel="Continue"
					onContinue={() => navigate('/welcome/connections')}
				/>
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
			<StepHeading title="Connect your services">
				Add an account, then choose what {agentName} may do with it. The rest can be connected
				later.
			</StepHeading>
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
			<StepHeading title="Connect a mailbox">
				Sign in with an app password made for this connection alone in your mail account. Revoking
				it there disconnects the mailbox.
			</StepHeading>
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
			<StepHeading title={`What can ${agentName} do with ${connection.account}?`}>
				Every agent gets what is ticked here unless its own page says otherwise. You can change it
				any time on the connection's page.
			</StepHeading>
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

import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import type {IntegrationId} from '@proxy/integrations';
import type {Experiment} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {setConnectionDefaults} from '@/client/connections-client';
import {finishOnboarding} from '@/client/orgs-client';
import {AddAgent} from '@/components/agent-setup';
import type {DatabaseDialect} from '@/client/connections-client';
import {ConnectBankForm} from '@/components/connect-bank-form';
import {ConnectDatabaseForm} from '@/components/connect-database-form';
import {ConnectEmailForm} from '@/components/connect-email-form';
import {ConnectMcpForm} from '@/components/connect-mcp-form';
import {ConnectionAccess, SignInAgain} from '@/components/connection-access';
import {IntegrationCatalog, SignInFailed} from '@/components/integration-catalog';
import {StepHeading} from '@/components/step-heading';
import {SuccessLine} from '@/components/success-line';
import {Button} from '@proxy/ui/components/button';
import {Card} from '@proxy/ui/components/card';
import {defaultActions, defaultsOnOrOff, integrationOf} from '@/lib/access';
import {
	describeDatabase,
	EMAIL_FORM,
	findIntegration,
	PLAID_FORM,
	signInPath,
	type Configured,
	type Integration,
} from '@/lib/integrations';
import {describeFetchError} from '@/lib/loader-utils';
import type {welcomeConnectionLoader, welcomeLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// Step one is the catalog, the form of an integration connected on one (a mailbox, a bank, a
// database, an MCP server), by its id, and (on its own page, `WelcomeConnectionPage`) a new
// connection's permissions; step two is the agent.
type Step = 'connections' | IntegrationId | 'agent';

// The welcome flow, before the app: step one connects the person's services, each connection's
// permissions confirmed as it is made, step two their agent, in the way that agent takes (an MCP
// client adds the server and signs in; another is handed a login). Done, or skipped, it is not
// shown again.
export function WelcomePage({step}: {step: Step}) {
	const org = useOrgSlug();
	const {agents, connections, configured, experiments} = useLoaderData<typeof welcomeLoader>();
	const navigate = useNavigate();
	const [finishing, setFinishing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [params] = useSearchParams();
	const agentName = agentNameOf(agents);
	// Only the choice of agent can be skipped: naming one (`?provider=`) and setting it up
	// (`?agent=`) go on with Finish or back to the choice.
	const skippable =
		step === 'connections' || (step === 'agent' && !params.has('provider') && !params.has('agent'));
	// The integration whose form this is, and the form.
	const connecting = step === 'connections' || step === 'agent' ? null : step;
	const form = connecting === null ? undefined : findIntegration(connecting)?.form;
	const onContinue = (connection: Connection) =>
		navigate(`/${org}/welcome/connections/${connection.id}`);

	const finish = async () => {
		setFinishing(true);
		const result = await finishOnboarding(org);
		if (result.isErr()) {
			setFinishing(false);
			setError(describeFetchError(result.error));
			return;
		}
		navigate(`/${org}/connections`);
	};

	return (
		<Frame step={step === 'agent' ? 2 : 1}>
			{step === 'connections' && (
				<ConnectionsStep
					agentName={agentName}
					connections={connections}
					configured={configured}
					experiments={experiments}
				/>
			)}
			{form === 'email' && <EmailStep onContinue={onContinue} />}
			{form === 'bank' && <BankStep onContinue={onContinue} />}
			{connecting && form === 'database' && (
				<DatabaseStep dialect={connecting} onContinue={onContinue} />
			)}
			{form === 'server' && <McpStep onContinue={onContinue} />}
			{step === 'agent' && (
				<AddAgent agents={agents} continueLabel="Finish" onContinue={() => void finish()} />
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			{skippable && (
				<button
					type="button"
					disabled={finishing}
					className="justify-self-start text-sm text-muted-foreground underline underline-offset-4"
					onClick={() => void finish()}
				>
					{step === 'connections' ? 'Skip setup' : 'Skip for now'}
				</button>
			)}
		</Frame>
	);
}

// A connection just made in the flow: what the agent may do with it, confirmed before going on.
export function WelcomeConnectionPage() {
	const org = useOrgSlug();
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
					render={<Link to={`/${org}/welcome/connections`} />}
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
				integration={integration}
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
		<div className="page-column flex min-h-dvh w-full justify-center bg-background pt-[12vh] pb-4 text-foreground">
			<div className="grid w-full max-w-lg content-start gap-4">
				<p className="text-sm text-muted-foreground">Step {step} of 2</p>
				{children}
			</div>
		</div>
	);
}

// The catalog: a plus per integration, and how many accounts of it are connected. A mailbox or a
// database goes to its form; a sign-in starts at the api and comes back to the connection's page here.
function ConnectionsStep({
	agentName,
	connections,
	configured,
	experiments,
}: {
	agentName: string;
	connections: Connection[];
	configured: Configured;
	experiments: Experiment[];
}) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const [params] = useSearchParams();

	return (
		<>
			<StepHeading title="Connect your services">
				Add an account, then choose what {agentName} may do with it. The rest can be connected
				later.
			</StepHeading>
			<SignInFailed error={params.get('error')} configured={configured} />
			<IntegrationCatalog
				connections={connections}
				configured={configured}
				experiments={experiments}
				returnTo="welcome"
				onConnectForm={(integrationId) => navigate(`/${org}/welcome/connections/${integrationId}`)}
				onConnected={(connection) => navigate(`/${org}/welcome/connections/${connection.id}`)}
			/>
			<div className="flex justify-end">
				<Button nativeButton={false} render={<Link to={`/${org}/welcome/agent`} />}>
					Continue
				</Button>
			</div>
		</>
	);
}

// The mailbox form. Test connection signs in without saving; Continue makes the connection and
// goes on to its permissions.
function EmailStep({onContinue}: {onContinue: (connection: Connection) => void}) {
	const org = useOrgSlug();
	return (
		<>
			<StepHeading title={EMAIL_FORM.title}>{EMAIL_FORM.intro}</StepHeading>
			<ConnectEmailForm
				cancel={
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link to={`/${org}/welcome/connections`} />}
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

// Connecting a bank through Plaid, which goes on to the new connection's permissions.
function BankStep({onContinue}: {onContinue: (connection: Connection) => void}) {
	const org = useOrgSlug();
	return (
		<>
			<StepHeading title={PLAID_FORM.title}>{PLAID_FORM.intro}</StepHeading>
			<ConnectBankForm
				cancel={
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link to={`/${org}/welcome/connections`} />}
					>
						Back
					</Button>
				}
				onConnected={onContinue}
			/>
		</>
	);
}

// The database form. Test connection signs in without saving; Continue makes the connection and
// goes on to its permissions.
function DatabaseStep({
	dialect,
	onContinue,
}: {
	dialect: DatabaseDialect;
	onContinue: (connection: Connection) => void;
}) {
	const org = useOrgSlug();
	const {title, intro} = describeDatabase(dialect);
	return (
		<>
			<StepHeading title={title}>{intro}</StepHeading>
			<ConnectDatabaseForm
				key={dialect}
				dialect={dialect}
				cancel={
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link to={`/${org}/welcome/connections`} />}
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

// The custom MCP server form. Connect makes the connection, or opens the server's sign-in, which
// comes back to the connection's permissions.
function McpStep({onContinue}: {onContinue: (connection: Connection) => void}) {
	const org = useOrgSlug();
	return (
		<>
			<StepHeading title="Connect an MCP server">
				Any MCP server over HTTP. Its tools become what the agent can be allowed, one by one.
			</StepHeading>
			<ConnectMcpForm
				cancel={
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link to={`/${org}/welcome/connections`} />}
					>
						Back
					</Button>
				}
				returnTo="welcome"
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
	integration,
}: {
	agentName: string;
	connection: Connection;
	integration: Integration;
}) {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const {revalidate} = useRevalidator();
	const [error, setError] = useState<string | null>(null);
	const defaults = defaultActions(connection);
	const signInAgain =
		connection.unavailable.length > 0
			? signInPath(org, connection.integrationId, {
					returnTo: 'welcome',
					account: connection.account,
					connection: connection.id,
				})
			: null;

	return (
		<>
			<StepHeading
				title={`What can ${agentName} do with ${connection.name ?? connection.account}?`}
			>
				Every agent gets what is ticked here unless its own page says otherwise. You can change it
				any time on the connection's page.
			</StepHeading>
			<SuccessLine>Connection added successfully</SuccessLine>
			{integration.disclosure && (
				<p className="text-sm text-muted-foreground">{integration.disclosure}</p>
			)}
			<Card>
				<ConnectionAccess
					actions={integration.actions}
					defaults={defaults}
					unavailable={connection.unavailable}
					signInNeeded={connection.signInNeeded}
					onChange={async (changes) => {
						const result = await setConnectionDefaults(
							org,
							connection.id,
							defaultsOnOrOff(changes),
						);
						setError(result.isErr() ? describeFetchError(result.error) : null);
						await revalidate();
					}}
				/>
			</Card>
			{signInAgain && (
				<SignInAgain
					href={signInAgain}
					reason={connection.signInNeeded ? 'needed' : 'unavailable'}
				/>
			)}
			{defaults.every((id) => connection.unavailable.includes(id)) && (
				<p className="text-sm text-muted-foreground">
					Nothing is ticked, so {agentName} can't use this account yet.
				</p>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex justify-end">
				<Button onClick={() => navigate(`/${org}/welcome/connections`)}>Confirm</Button>
			</div>
		</>
	);
}

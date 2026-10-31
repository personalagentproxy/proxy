import type {Connection} from '@proxy/contracts/connections';
import {isOffered, type IntegrationId} from '@proxy/integrations';
import {useState} from 'react';
import type {Experiment} from '@proxy/utils';
import {Badge} from '@proxy/ui/components/badge';
import {buttonVariants} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import {KeyRoundIcon, PlusIcon} from 'lucide-react';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConnectWithKeyDialog} from '@/components/connect-with-key-dialog';
import {IconButton} from '@/components/icon-button';
import {RowList} from '@/components/row-list';
import {
	INTEGRATIONS,
	NEEDS,
	signInFailedMessage,
	signInPath,
	unmetNeed,
	type Configured,
	type Need,
} from '@/lib/integrations';
import {useOrgSlug} from '@/hooks/use-org';

// The integrations not connected by signing in to them are connected on a form of their own: a
// mailbox with an app password, a database with a user's name and password, a custom MCP server by
// its address. One that also takes an API key, as Cloudflare, Exa, Keenable, Linear and Parallel
// do, has a key before its plus, which takes the key in a dialog here; its plus is then a link of
// its own beside the row's.

// The whole row is the link or button, out in the list's gutter as a row of `RowList` is; its plus is
// styled as a ghost icon button that lights up with the row, and dimmed on a row greyed out.
const ROW =
	'group flex min-h-14 w-full items-center gap-3 px-(--bleed) py-2 text-left text-sm outline-none';
const PLUS_BUTTON = buttonVariants({variant: 'ghost', size: 'icon-sm'});
const PLUS = cn(
	PLUS_BUTTON,
	'group-hover:bg-muted group-hover:text-foreground group-focus-visible:border-ring group-focus-visible:ring-3 group-focus-visible:ring-ring/50 group-active:translate-y-px dark:group-hover:bg-muted/50',
);

// The catalog: every integration, a plus to connect it, and how many accounts are connected. Each
// can be connected again, for another mailbox, account or server. One that needs what the server
// doesn't have, such as Google without its client, is greyed out, saying what to set up. One behind
// an experiment the organization doesn't have on isn't offered.
export function IntegrationCatalog({
	connections,
	configured,
	experiments,
	returnTo,
	shared = false,
	onConnectForm,
	onConnected,
}: {
	connections: Connection[];
	configured: Configured;
	// The experiments on for the organization.
	experiments: Experiment[];
	returnTo?: 'welcome';
	// A new connection is for every member of the organization rather than the person's own.
	shared?: boolean;
	// The integration's form, by its id.
	onConnectForm: (integrationId: IntegrationId) => void;
	// A connection made here, with an API key.
	onConnected: (connection: Connection) => void;
}) {
	const org = useOrgSlug();
	const available = INTEGRATIONS.filter(
		(integration) => !integration.builtIn && isOffered(integration, {experiments}),
	);
	// The integration a key is being typed for, in the dialog.
	const [keyFor, setKeyFor] = useState<IntegrationId | null>(null);

	return (
		<>
			{keyFor && (
				<ConnectWithKeyDialog
					integrationId={keyFor}
					shared={shared}
					onClose={() => setKeyFor(null)}
					onConnected={onConnected}
				/>
			)}
			<RowList>
				{available.map((integration) => {
					const count = connections.filter(
						(connection) => connection.integrationId === integration.id,
					).length;
					const signIn = signInPath(org, integration.id, {
						returnTo,
						share: shared ? 'everyone' : undefined,
					});
					const unmet =
						integration.needs && !configured[integration.needs] ? integration.needs : null;
					const content = (
						<>
							<IntegrationLogo
								integration={integration}
								className={cn('size-7', unmet && 'opacity-50')}
							/>
							<span className="grid min-w-0 flex-1">
								<span className="flex items-baseline gap-2">
									<span className={cn('truncate', unmet && 'opacity-50')}>{integration.name}</span>
									{count > 0 && (
										<Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
											{count} connected
										</Badge>
									)}
								</span>
								<span
									className={cn('truncate text-sm text-muted-foreground', unmet && 'opacity-50')}
								>
									{integration.description}
								</span>
								{unmet && (
									<span className="text-sm text-muted-foreground">
										<ServerNeeds need={unmet} />
									</span>
								)}
							</span>
							{!integration.apiKey && (
								<span className={unmet ? cn(PLUS_BUTTON, 'opacity-50') : PLUS}>
									<PlusIcon />
								</span>
							)}
						</>
					);
					return (
						<li key={integration.id} className="-mx-(--bleed) flex items-center">
							{unmet && <div className={ROW}>{content}</div>}
							{!unmet && signIn && (
								<a href={signIn} className={ROW}>
									{content}
								</a>
							)}
							{!unmet && !signIn && (
								<button type="button" onClick={() => onConnectForm(integration.id)} className={ROW}>
									{content}
								</button>
							)}
							{!unmet && signIn && integration.apiKey && (
								<span className="flex items-center gap-1 pr-(--bleed)">
									<IconButton
										label={`Connect ${integration.name} with an API key`}
										onClick={() => setKeyFor(integration.id)}
									>
										<KeyRoundIcon />
									</IconButton>
									<IconButton label={`Sign in with ${integration.name}`} href={signIn}>
										<PlusIcon />
									</IconButton>
								</span>
							)}
						</li>
					);
				})}
			</RowList>
		</>
	);
}

// What the server needs set for an integration, with the docs page on setting it up.
function ServerNeeds({need}: {need: Need}) {
	const {variables, docsUrl} = NEEDS[need];
	return (
		<>
			Needs{' '}
			{variables.map((variable, index) => (
				<span key={variable}>
					{index > 0 && ' and '}
					<span className="font-mono">{variable}</span>
				</span>
			))}{' '}
			on the server. See{' '}
			<a
				href={docsUrl}
				target="_blank"
				rel="noreferrer"
				className="text-foreground underline underline-offset-4"
			>
				the docs
			</a>
			.
		</>
	);
}

// Why a sign-in sent back to the catalog with `?error=` didn't go through: the server lacking what
// the integration needs, said as the catalog's row says it, unless it has it by now, or the
// sign-in not finishing.
export function SignInFailed({error, configured}: {error: string | null; configured: Configured}) {
	const unmet = unmetNeed(error);
	if (unmet && configured[unmet]) {
		return null;
	}
	if (unmet) {
		return (
			<p className="text-sm text-destructive">
				<ServerNeeds need={unmet} />
			</p>
		);
	}

	const failed = signInFailedMessage(error);
	if (!failed) {
		return null;
	}
	return <p className="text-sm text-destructive">{failed}</p>;
}

import type {Connection, ConnectionHealth} from '@proxy/contracts/connections';
import {Button, buttonVariants} from '@proxy/ui/components/button';
import {ActivityIcon} from 'lucide-react';
import {Link} from 'react-router';

import {useConnectionHealth} from '@/hooks/use-connection-health';
import {useOrgSlug} from '@/hooks/use-org';
import {integrationOf} from '@/lib/access';
import {signInPath} from '@/lib/integrations';
import {onSignInClick} from '@/lib/desktop';

const LABELS: Record<ConnectionHealth['status'], string> = {
	healthy: 'Healthy',
	sign_in_required: 'Sign in required',
	unreachable: 'Unreachable',
	unsupported: 'Not supported',
	error: 'Check failed',
};

export function ConnectionHealthStatus({
	health,
	checking = false,
}: {
	health?: ConnectionHealth;
	checking?: boolean;
}) {
	if (checking) {
		return <span className="text-xs text-muted-foreground">Checking…</span>;
	}
	if (!health) {
		return <span className="text-xs text-muted-foreground">Not checked</span>;
	}
	const failed = health.status !== 'healthy' && health.status !== 'unsupported';
	return (
		<span
			title={`${health.message} Checked ${new Date(health.checkedAt).toLocaleString()}`}
			className={`text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}
		>
			{LABELS[health.status]}
		</span>
	);
}

/** A check never changes access or runs a customer operation. */
export function ConnectionHealthPanel({
	connection,
	mayChange,
}: {
	connection: Connection;
	mayChange: boolean;
}) {
	const org = useOrgSlug();
	const {results, checking, check} = useConnectionHealth(org);
	const health = results[connection.id];
	const pending = checking.has(connection.id);
	const integration = integrationOf(connection);
	if (integration?.native) {
		return null;
	}
	const signIn = signInPath(org, connection.integrationId, {
		account: connection.account,
		connection: connection.id,
	});
	const customReconnect = `/${org}/connections/new/mcp?${new URLSearchParams({name: connection.name ?? connection.account, url: `https://${connection.account}`})}`;
	return (
		<section aria-label="Connection health" className="flex flex-col gap-2 rounded-lg border p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-sm">
					<ActivityIcon className="size-4" />
					<span>Connection health</span>
					<ConnectionHealthStatus health={health} checking={pending} />
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={pending}
					onClick={() => void check(connection.id)}
				>
					{pending ? 'Checking…' : 'Check connection'}
				</Button>
			</div>
			<p className="text-sm text-muted-foreground">
				{health?.message ??
					'Credentials are saved. Check whether the provider responds before relying on this connection.'}
			</p>
			{health && (
				<p className="text-xs text-muted-foreground">
					Checked{' '}
					<time dateTime={health.checkedAt}>{new Date(health.checkedAt).toLocaleString()}</time>.
					Checks run only when requested.
				</p>
			)}
			{health?.status === 'sign_in_required' && mayChange && integration?.custom && (
				<Link
					className={buttonVariants({size: 'sm', variant: 'outline', className: 'self-start'})}
					to={customReconnect}
				>
					Reconnect
				</Link>
			)}
			{health?.status === 'sign_in_required' && mayChange && signIn && (
				<a
					className={buttonVariants({size: 'sm', variant: 'outline', className: 'self-start'})}
					href={signIn}
					onClick={onSignInClick}
				>
					Sign in again
				</a>
			)}
			{health?.status === 'sign_in_required' && !mayChange && (
				<p className="text-sm">Ask the connection owner to sign in again.</p>
			)}
		</section>
	);
}

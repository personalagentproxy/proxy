import type {Connection, ConnectionHealth} from '@proxy/contracts/connections';
import {PillButton} from '@proxy/ui/components/pill-button';
import {pillButtonVariants} from '@proxy/ui/lib/pill-variants';
import {
	ActivityIcon,
	CircleAlertIcon,
	CircleCheckIcon,
	CircleHelpIcon,
	CircleMinusIcon,
	LoaderCircleIcon,
} from 'lucide-react';
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
		return (
			<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
				<LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
				Checking…
			</span>
		);
	}
	if (!health) {
		return (
			<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
				<CircleHelpIcon aria-hidden="true" className="size-3.5 shrink-0" />
				Not checked
			</span>
		);
	}
	const failed = health.status !== 'healthy' && health.status !== 'unsupported';
	const Icon =
		health.status === 'healthy' ? CircleCheckIcon : failed ? CircleAlertIcon : CircleMinusIcon;
	const color =
		health.status === 'healthy'
			? 'text-emerald-600 dark:text-emerald-400'
			: failed
				? 'text-destructive'
				: 'text-muted-foreground';
	return (
		<span
			title={`${health.message} Checked ${new Date(health.checkedAt).toLocaleString()}`}
			className={`inline-flex items-center gap-1 text-xs ${color}`}
		>
			<Icon aria-hidden="true" className="size-3.5 shrink-0" />
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
	const reconnect = health?.status === 'sign_in_required' && mayChange;
	return (
		<section
			aria-label="Connection health"
			className="flex flex-col gap-1 rounded-md border px-3 py-2"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-xs">
					<ActivityIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
					<span className="text-muted-foreground">Connection health</span>
					<ConnectionHealthStatus health={health} checking={pending} />
				</div>
				<div className="flex items-center gap-2">
					{reconnect && integration?.custom && (
						<Link
							className={`${pillButtonVariants({variant: 'outline'})} h-7 px-2 text-xs`}
							to={customReconnect}
						>
							Reconnect
						</Link>
					)}
					{reconnect && signIn && (
						<a
							className={`${pillButtonVariants({variant: 'outline'})} h-7 px-2 text-xs`}
							href={signIn}
							onClick={onSignInClick}
						>
							Reconnect
						</a>
					)}
					<PillButton
						variant="outline"
						className="h-7 px-2 text-xs"
						disabled={pending}
						onClick={() => void check(connection.id)}
					>
						{pending ? 'Checking…' : 'Check connection'}
					</PillButton>
				</div>
			</div>
			<p className="text-xs text-muted-foreground">
				{health?.message ??
					'Credentials are saved. Check whether the provider responds before relying on this connection.'}
				{health && (
					<>
						{' '}
						Checked{' '}
						<time dateTime={health.checkedAt}>{new Date(health.checkedAt).toLocaleString()}</time>.
					</>
				)}{' '}
				Checks run only when requested.
			</p>
			{health?.status === 'sign_in_required' && !mayChange && (
				<p className="text-xs">Ask the connection owner to sign in again.</p>
			)}
		</section>
	);
}

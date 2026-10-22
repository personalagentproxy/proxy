import {findIntegration, type IntegrationId} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {useState} from 'react';
import {connectWithKey} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {apiMessage} from '@/lib/agent-errors';
import type {Connection} from '@/lib/types';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';
import {useOrgSlug} from '@/hooks/use-org';

function connectErrorMessage(service: string, error: FetchError): string {
	if (error.kind === 'http' && error.status === 400) {
		return apiMessage(error.body) ?? 'Check the key.';
	}
	if (error.kind === 'http' && error.status === 422) {
		return `${service} turned the key down. Check it and try again.`;
	}
	if (error.kind === 'http' && error.status === 502) {
		return `${service} could not be reached. Try again.`;
	}
	return 'Something went wrong. Try again.';
}

type Props = {
	integrationId: IntegrationId;
	// The connection to give the key, as its page does; else a new one is made.
	connectionId?: string;
	// A new connection is for every member of the organization rather than the person's own.
	shared?: boolean;
	onClose: () => void;
	onConnected: (connection: Connection) => void;
};

// Connecting an integration that takes an API key, Cloudflare, Exa, Linear or Parallel, in a small
// dialog: the key, checked with the service before the connection is made, and where to get one.
// The connection shows as the key's account, or its end where the service names none; it can be
// renamed from the connections list.
export function ConnectWithKeyDialog({
	integrationId,
	connectionId,
	shared,
	onClose,
	onConnected,
}: Props) {
	const org = useOrgSlug();
	const integration = findIntegration(integrationId);
	const [key, setKey] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	if (!integration?.apiKey) {
		return null;
	}
	const service = integration.name;
	const keysHost = new URL(integration.apiKey.keysUrl).host;
	const ready = key.trim() !== '';

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!ready) {
							return;
						}
						setPending(true);
						setError(null);
						const result = await connectWithKey(org, integrationId, {
							key: key.trim(),
							...(connectionId === undefined ? {} : {connection: connectionId}),
							...(shared ? {shared} : {}),
						});
						setPending(false);
						if (result.isErr()) {
							setError(connectErrorMessage(service, result.error));
							return;
						}
						onConnected(result.value);
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{connectionId === undefined
								? `Connect ${service} with an API key`
								: `Replace the ${service} API key`}
						</DialogTitle>
						<DialogDescription>
							{connectionId === undefined
								? `Agents use ${service} as the key's account.`
								: `The new key replaces what this connection reaches ${service} with. Its name and every agent's settings stay.`}
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="connect-key">API key</Label>
						<Input
							id="connect-key"
							type="password"
							autoFocus
							{...NO_PASSWORD_MANAGER}
							value={key}
							onChange={(event) => setKey(event.target.value)}
						/>
						<p className="text-sm text-muted-foreground">
							Made at{' '}
							<a
								href={integration.apiKey.keysUrl}
								target="_blank"
								rel="noreferrer"
								className="text-foreground underline underline-offset-4"
							>
								{keysHost}
							</a>
							.
						</p>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!ready || pending}>
							{pending ? 'Checking the key…' : 'Connect'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

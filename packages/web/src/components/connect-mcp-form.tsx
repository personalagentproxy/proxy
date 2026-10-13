import type {FetchError} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {connectMcp} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {apiMessage} from '@/lib/agent-errors';
import type {Connection} from '@/lib/types';

function connectErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && error.status === 400) {
		return apiMessage(error.body) ?? 'Check the address.';
	}
	if (error.kind === 'http' && error.status === 422) {
		return 'The server turned the token down. Check it and try again.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'The server could not be reached, or did not answer as an MCP server. Check the address and try again.';
	}
	return 'Something went wrong. Try again.';
}

// The custom MCP server form: the server's address, and a token where the server takes one
// instead of a sign-in. Connecting asks the server for its tools: a server that answers is
// connected at once, and for one that asks for a sign-in the api begins it and answers the
// server's sign-in page, which the browser goes to; it comes back to the new connection, or to the
// welcome flow's page for it. `cancel` sits beside the button.
export function ConnectMcpForm({
	cancel,
	returnTo,
	onConnected,
}: {
	cancel?: ReactNode;
	returnTo?: 'welcome';
	onConnected: (connection: Connection) => void;
}) {
	const [url, setUrl] = useState('');
	const [token, setToken] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<'connecting' | 'signingIn' | null>(null);
	const ready = url.trim() !== '';

	return (
		<form
			className="grid gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				setPending('connecting');
				setError(null);
				const result = await connectMcp({
					url: url.trim(),
					...(token.trim() ? {token: token.trim()} : {}),
					...(returnTo ? {returnTo} : {}),
				});
				if (result.isErr()) {
					setPending(null);
					setError(connectErrorMessage(result.error));
					return;
				}
				if (result.value.kind === 'signIn') {
					setPending('signingIn');
					window.location.assign(result.value.url);
					return;
				}
				onConnected(result.value.connection);
			}}
		>
			<div className="grid gap-2">
				<Label htmlFor="mcp-url">Server address</Label>
				<Input
					id="mcp-url"
					type="url"
					autoComplete="off"
					placeholder="https://mcp.example.com/mcp"
					value={url}
					onChange={(event) => setUrl(event.target.value)}
				/>
				<p className="text-sm text-muted-foreground">
					The server's MCP address, reachable from the internet over https. A server that asks you
					to sign in opens its sign-in page.
				</p>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="mcp-token">Access token (optional)</Label>
				<Input
					id="mcp-token"
					type="password"
					autoComplete="off"
					value={token}
					onChange={(event) => setToken(event.target.value)}
				/>
				<p className="text-sm text-muted-foreground">
					Only where the server takes a token or API key instead of a sign-in. It is sent as a
					bearer token with every request, or as written when it starts with its scheme, such as{' '}
					<code>Basic …</code>.
				</p>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex justify-end gap-2">
				{cancel}
				<Button type="submit" disabled={!ready || pending !== null}>
					{pending === 'signingIn'
						? 'Opening sign-in…'
						: pending === 'connecting'
							? 'Connecting…'
							: 'Connect'}
				</Button>
			</div>
		</form>
	);
}

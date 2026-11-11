import type {Connection} from '@proxy/contracts/connections';
import type {FetchError} from '@proxy/utils';
import {useState, type ReactNode} from 'react';
import {useSearchParams} from 'react-router';
import {connectMcp} from '@/client/connections-client';
import {PillButton} from '@/components/pill-button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {apiMessage} from '@/lib/agent-errors';
import {handOffToBrowser, isDesktopApp} from '@/lib/desktop';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';
import {useCommandEnterSubmit} from '@/hooks/use-command-enter';
import {useOrgSlug} from '@/hooks/use-org';

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

// The custom MCP server form: a name for the connection, since a server says nothing about itself
// that would do, the server's address, and a token where the server takes one instead of a
// sign-in. Connecting asks the server for its tools: a server that answers is
// connected at once, and for one that asks for a sign-in the api begins it and answers the
// server's sign-in page, which the browser goes to; it comes back to the new connection, or to the
// welcome flow's page for it. In the desktop app, whose window a sign-in page would turn away, the
// form moves to the browser instead, filled in as it was (`?name=&url=`), to be sent again there,
// marked `?desktop=1` so the sign-in ends back in the app (`/desktop-return`), which then shows the
// new connection in place of this form. `cancel` sits beside the button.
export function ConnectMcpForm({
	cancel,
	returnTo,
	shared,
	onConnected,
}: {
	cancel?: ReactNode;
	returnTo?: 'welcome';
	// For every member of the organization rather than the person's own.
	shared?: boolean;
	onConnected: (connection: Connection) => void;
}) {
	const org = useOrgSlug();
	const [params] = useSearchParams();
	const [name, setName] = useState(params.get('name') ?? '');
	const [url, setUrl] = useState(params.get('url') ?? '');
	const [token, setToken] = useState('');
	// Sent again from the browser for the desktop app.
	const fromDesktop = params.get('desktop') === '1';
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState<'connecting' | 'signingIn' | null>(null);
	const ready = name.trim() !== '' && url.trim() !== '';
	const form = useCommandEnterSubmit(ready && pending === null);

	return (
		<form
			ref={form}
			className="grid gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				setPending('connecting');
				setError(null);
				setNotice(null);
				const result = await connectMcp(org, {
					name: name.trim(),
					url: url.trim(),
					...(token.trim() ? {token: token.trim()} : {}),
					...(returnTo ? {returnTo} : {}),
					...(shared ? {shared} : {}),
					...(fromDesktop ? {desktop: true} : {}),
				});
				if (result.isErr()) {
					setPending(null);
					setError(connectErrorMessage(result.error));
					return;
				}
				if (result.value.kind === 'signIn') {
					if (isDesktopApp()) {
						const here = new URL(window.location.href);
						here.searchParams.set('name', name.trim());
						here.searchParams.set('url', url.trim());
						here.searchParams.set('desktop', '1');
						handOffToBrowser(`${here.pathname}${here.search}`);
						// The form stays as it is, to be sent again should the browser not come back.
						setPending(null);
						setNotice(
							'Sign in to the server in your browser. The connection shows here once you have.',
						);
						return;
					}
					// Only ever a web address: the api has checked it, and the browser goes nowhere else.
					if (!/^https?:\/\//.test(result.value.url)) {
						setPending(null);
						setError('The server’s sign-in page is not a web address.');
						return;
					}
					setPending('signingIn');
					window.location.assign(result.value.url);
					return;
				}
				onConnected(result.value.connection);
			}}
		>
			<div className="grid gap-2">
				<Label htmlFor="mcp-name">Name</Label>
				<Input
					id="mcp-name"
					autoComplete="off"
					maxLength={80}
					placeholder="Company docs"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<p className="text-sm text-muted-foreground">
					What this connection is called here and to agents.
				</p>
			</div>
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
					{...NO_PASSWORD_MANAGER}
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
			{notice && <p className="text-sm text-muted-foreground">{notice}</p>}
			<div className="flex justify-end gap-2">
				{cancel}
				<PillButton type="submit" disabled={!ready || pending !== null}>
					{pending === 'signingIn'
						? 'Opening sign-in…'
						: pending === 'connecting'
							? 'Connecting…'
							: 'Connect'}
				</PillButton>
			</div>
		</form>
	);
}

import type {Connection, CustomMcpServer} from '@proxy/contracts/connections';
import type {FetchError} from '@proxy/utils';
import {useState} from 'react';
import {editMcpServer} from '@/client/connections-client';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Checkbox} from '@proxy/ui/components/checkbox';
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
import {apiMessage} from '@/lib/api-message';
import {handOffToBrowser, isDesktopApp} from '@/lib/desktop';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';
import {useOrgSlug} from '@/hooks/use-org';

function editErrorMessage(error: FetchError): string {
	if (error.kind === 'http' && (error.status === 400 || error.status === 409)) {
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

// What the token field says, by how the connection signs in now.
function tokenHint(auth: CustomMcpServer['auth']): string {
	if (auth === 'token') {
		return 'Leave it empty to keep the current token, which is only sent to the same server. A new one is sent as a bearer token, or as written when it starts with its scheme, such as Basic ….';
	}
	if (auth === 'oauth') {
		return 'Leave it empty to sign in to the server again. Only where the server takes a token or API key instead of a sign-in.';
	}
	return 'Only where the server takes a token or API key instead of a sign-in. It is sent as a bearer token, or as written when it starts with its scheme, such as Basic ….';
}

// The token the server is sent from now on: none, a new one, or, left out, the current one.
function tokenChange(typed: string, drop: boolean): {token?: string | null} {
	if (drop) {
		return {token: null};
	}
	if (typed.trim() === '') {
		return {};
	}
	return {token: typed.trim()};
}

type Props = {
	connection: Connection;
	server: CustomMcpServer;
	// Filled in as it was in the desktop app, which hands a sign-in over to the browser (`?url=`,
	// `?token=none`, `?desktop=1`).
	handedOver: {url: string | null; dropToken: boolean; desktop: boolean};
	onClose: () => void;
	onSaved: () => void;
};

// Moving a custom MCP connection to another address or token: the server there is asked for its
// tools before anything is kept, and one that asks for a sign-in opens it, coming back to this
// connection. The address left as it was keeps the one stored, its query too, which isn't shown;
// the token left empty keeps the current one. In the desktop app a sign-in moves to the browser,
// the dialog filled in there as it was, to be sent again, as the connect form does.
export function EditMcpServerDialog({connection, server, handedOver, onClose, onSaved}: Props) {
	const org = useOrgSlug();
	const [url, setUrl] = useState(handedOver.url ?? server.url);
	const [token, setToken] = useState('');
	const [dropToken, setDropToken] = useState(handedOver.dropToken);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState<'saving' | 'signingIn' | null>(null);
	const ready = url.trim() !== '';

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
						setPending('saving');
						setError(null);
						setNotice(null);
						const changedUrl = url.trim() === server.url ? undefined : url.trim();
						const result = await editMcpServer(org, connection.id, {
							...(changedUrl === undefined ? {} : {url: changedUrl}),
							...tokenChange(token, dropToken),
							...(handedOver.desktop ? {desktop: true} : {}),
						});
						if (result.isErr()) {
							setPending(null);
							setError(editErrorMessage(result.error));
							return;
						}
						if (result.value.kind === 'connected') {
							onSaved();
							return;
						}
						if (isDesktopApp()) {
							const here = new URL(window.location.href);
							here.searchParams.set('server', 'edit');
							here.searchParams.set('url', url.trim());
							here.searchParams.set('desktop', '1');
							if (dropToken) {
								here.searchParams.set('token', 'none');
							}
							handOffToBrowser(`${here.pathname}${here.search}`);
							setPending(null);
							setNotice(
								'Sign in to the server in your browser. The connection shows the new server once you have.',
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
					}}
				>
					<DialogHeader>
						<DialogTitle>Edit the server</DialogTitle>
						<DialogDescription>
							The server at the address is asked for its tools before anything changes. The
							connection keeps its name, its agents’ settings for the tools still listed, and its
							activity.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="edit-mcp-url">Server address</Label>
						<Input
							id="edit-mcp-url"
							type="url"
							autoComplete="off"
							placeholder="https://mcp.example.com/mcp"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
						/>
						<p className="text-sm text-muted-foreground">
							Left as it is, the address keeps anything after a ? it was connected with.
						</p>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="edit-mcp-token">
							{server.auth === 'token' ? 'New access token' : 'Access token (optional)'}
						</Label>
						<Input
							id="edit-mcp-token"
							type="password"
							disabled={dropToken}
							placeholder={server.auth === 'token' ? 'Unchanged' : undefined}
							{...NO_PASSWORD_MANAGER}
							value={token}
							onChange={(event) => setToken(event.target.value)}
						/>
						<p className="text-sm text-muted-foreground">{tokenHint(server.auth)}</p>
						{server.auth === 'token' && (
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={dropToken}
									onCheckedChange={(checked) => setDropToken(checked)}
								/>
								Remove the token
							</label>
						)}
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					{notice && <p className="text-sm text-muted-foreground">{notice}</p>}
					<DialogFooter>
						<PillButton type="button" variant="ghost" onClick={onClose}>
							Cancel
						</PillButton>
						<PillButton type="submit" disabled={!ready || pending !== null}>
							{pending === 'signingIn'
								? 'Opening sign-in…'
								: pending === 'saving'
									? 'Asking the server…'
									: 'Save'}
						</PillButton>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

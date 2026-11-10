/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, redirect, RouterProvider, useParams} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {AppShell, PageHeader, PageTitle} from '@/components/app-shell';
import {HumanSide} from '@/components/human-side';
import {useLastLoaded, useLoaded} from '@/hooks/use-loaded';
import {useReload} from '@/hooks/use-reload';
import {later, LoadFailure} from '@/lib/loader-utils';
import {testHuman} from '@/test-org';

afterEach(() => {
	cleanup();
	// What a test wrote beside the page, as the word a reload leaves when it is done.
	document.body.textContent = '';
});

type Thing = {name: string};

// An answer the test gives when it chooses to, as the api would in its own time.
type Pending = {answer: (thing: Thing) => void; fail: (error: Error) => void};

function pendingLoader() {
	const asked: Pending[] = [];
	const loader = later(
		() =>
			new Promise<Thing>((answer, fail) => {
				asked.push({answer, fail});
			}),
	);
	return {loader, asked};
}

type ThingLoader = ReturnType<typeof pendingLoader>['loader'];

// A page whose frame knows its title, and whose content says what was loaded, with an action in
// the header and a button that loads it again.
function ListPage() {
	return (
		<AppShell title={<PageTitle>Things</PageTitle>}>
			<List />
		</AppShell>
	);
}

function List() {
	const {name} = useLoaded<ThingLoader>();
	const reload = useReload();
	return (
		<>
			<PageHeader actions={<button type="button">Add to {name}</button>} />
			<p>Listed: {name}</p>
			<button
				type="button"
				onClick={() => void reload().then(() => document.body.append('reloaded'))}
			>
				Reload
			</button>
		</>
	);
}

// A page named by what it loads, for the thing in its address.
function DetailPage() {
	return (
		<AppShell loadsTitle>
			<Detail />
		</AppShell>
	);
}

// A page with a panel of its frame's, which says what was last loaded, beside the thing in its
// address.
function PanelPage() {
	const {answer, pending} = useLastLoaded<ThingLoader>();
	return (
		<AppShell
			title={<PageTitle>Things</PageTitle>}
			actions={<button type="button">New thing</button>}
			panel={
				<p>
					Last: {answer?.name ?? 'none'}
					{pending && ', loading'}
				</p>
			}
		>
			<Detail />
		</AppShell>
	);
}

function Detail() {
	const {name} = useLoaded<ThingLoader>();
	const {id} = useParams();
	return (
		<>
			<PageHeader title={<PageTitle>{name}</PageTitle>} />
			<p>
				Thing {id}: {name}
			</p>
		</>
	);
}

function renderAt(entry: string, loader: ThingLoader) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => testHuman(),
				element: <HumanSide />,
				children: [
					{path: '/:org/things', loader, element: <ListPage />},
					{path: '/:org/things/:id', loader, element: <DetailPage />},
					{path: '/:org/beside/:id', loader, element: <PanelPage />},
					{path: '/:org/elsewhere', element: <p>Elsewhere</p>},
				],
			},
		],
		{initialEntries: [entry]},
	);
	render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
	return router;
}

const waiting = () => screen.queryByRole('status', {name: 'Loading'});

describe('AppShell', () => {
	test('is up before the content has loaded, which stands in its place until it has', async () => {
		const {loader, asked} = pendingLoader();
		renderAt('/acme/things', loader);

		expect((await screen.findByRole('banner')).textContent).toBe('Things');
		expect(screen.getByRole('link', {name: 'Connections and permissions'})).toBeDefined();
		expect(waiting()).not.toBeNull();
		expect(screen.queryByText(/Listed/)).toBeNull();

		await act(async () => asked[0]?.answer({name: 'first'}));
		expect((await screen.findByText('Listed: first')).closest('main')).not.toBeNull();
		expect(waiting()).toBeNull();
		// The content's action is in the header, beside the frame's title.
		expect(screen.getByRole('banner').textContent).toBe('ThingsAdd to first');
	});

	test('keeps its sidebar from one page to the next', async () => {
		const {loader, asked} = pendingLoader();
		const router = renderAt('/acme/things', loader);
		await screen.findByRole('banner');
		await act(async () => asked[0]?.answer({name: 'first'}));
		const connections = await screen.findByRole('link', {name: 'Connections and permissions'});

		// Drawn again, the label of the destination just clicked would open again under the pointer.
		await act(async () => router.navigate('/acme/things/1'));
		await act(async () => asked[1]?.answer({name: 'One'}));
		await screen.findByText('Thing 1: One');
		expect(screen.getByRole('link', {name: 'Connections and permissions'})).toBe(connections);
	});

	test('holds the place of a title the content gives', async () => {
		const {loader, asked} = pendingLoader();
		renderAt('/acme/things/1', loader);

		const header = await screen.findByRole('banner');
		expect(header.textContent).toBe('');
		expect(header.querySelector('[data-slot=skeleton]')).not.toBeNull();

		await act(async () => asked[0]?.answer({name: 'One'}));
		await screen.findByText('Thing 1: One');
		expect(header.textContent).toBe('One');
		expect(header.querySelector('[data-slot=skeleton]')).toBeNull();
	});

	test('keeps the content as it is while it is loaded again', async () => {
		const {loader, asked} = pendingLoader();
		renderAt('/acme/things', loader);
		await screen.findByRole('banner');
		await act(async () => asked[0]?.answer({name: 'first'}));

		fireEvent.click(await screen.findByRole('button', {name: 'Reload'}));
		await waitFor(() => expect(asked).toHaveLength(2));
		expect(screen.getByText('Listed: first')).toBeDefined();
		expect(waiting()).toBeNull();
		// Loading again is done once the new answer has come, not once it was asked for.
		expect(document.body.textContent).not.toContain('reloaded');

		await act(async () => asked[1]?.answer({name: 'second'}));
		await screen.findByText('Listed: second');
		expect(document.body.textContent).toContain('reloaded');
	});

	test('loading again does not wait for a page left before its answer came', async () => {
		const {loader, asked} = pendingLoader();
		const router = renderAt('/acme/things/1', loader);
		await screen.findByRole('banner');
		// Thing 1 never answers; the list, opened in its place, does.
		await act(async () => router.navigate('/acme/things'));
		await act(async () => asked[1]?.answer({name: 'first'}));

		fireEvent.click(await screen.findByRole('button', {name: 'Reload'}));
		await waitFor(() => expect(asked).toHaveLength(3));
		await act(async () => asked[2]?.answer({name: 'second'}));
		await screen.findByText('Listed: second');
		await waitFor(() => expect(document.body.textContent).toContain('reloaded'));
	});

	test('starts the content over at another of the page’s addresses', async () => {
		const {loader, asked} = pendingLoader();
		const router = renderAt('/acme/things/1', loader);
		await screen.findByRole('banner');
		await act(async () => asked[0]?.answer({name: 'One'}));
		await screen.findByText('Thing 1: One');

		await act(async () => router.navigate('/acme/things/2'));
		expect(screen.queryByText(/Thing 1/)).toBeNull();
		expect(waiting()).not.toBeNull();

		await act(async () => asked[1]?.answer({name: 'Two'}));
		expect(await screen.findByText('Thing 2: Two')).toBeDefined();
	});

	test('keeps its own panel and actions as they are while the content loads', async () => {
		const {loader, asked} = pendingLoader();
		const router = renderAt('/acme/beside/1', loader);
		await screen.findByRole('banner');
		expect(screen.getByText('Last: none, loading')).toBeDefined();
		expect(screen.getByRole('button', {name: 'New thing'})).toBeDefined();

		await act(async () => asked[0]?.answer({name: 'One'}));
		await screen.findByText('Thing 1: One');
		expect(screen.getByText('Last: One')).toBeDefined();

		// At the next address the content waits; the panel shows what it last did.
		await act(async () => router.navigate('/acme/beside/2'));
		expect(waiting()).not.toBeNull();
		expect(screen.getByText('Last: One, loading')).toBeDefined();
		expect(screen.getByRole('button', {name: 'New thing'})).toBeDefined();

		await act(async () => asked[1]?.answer({name: 'Two'}));
		await screen.findByText('Thing 2: Two');
		expect(screen.getByText('Last: Two')).toBeDefined();
	});

	test('follows a redirect the loader answers with', async () => {
		const loader = later(async (): Promise<Thing> => {
			throw redirect('/acme/elsewhere');
		});
		renderAt('/acme/things', loader);

		expect(await screen.findByText('Elsewhere')).toBeDefined();
	});

	test('says in the frame that the content could not be loaded', async () => {
		const {loader, asked} = pendingLoader();
		renderAt('/acme/things', loader);
		await screen.findByRole('banner');

		// React reports what a boundary catches on the console, which is not this test's to show.
		const reported = console.error;
		console.error = () => undefined;
		await act(async () => asked[0]?.fail(new LoadFailure(false, 'network')));
		console.error = reported;

		expect(await screen.findByText('Something went wrong loading this page.')).toBeDefined();
		expect(screen.getByRole('banner').textContent).toBe('Things');
		expect(screen.getByRole('link', {name: 'Connections and permissions'})).toBeDefined();
	});
});

import {
	createContext,
	type ReactNode,
	Suspense,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
import {createPortal} from 'react-dom';
import {useLoaderData, useLocation, useNavigate} from 'react-router';
import {ContentBoundary} from '@/components/route-error';
import {InSidebar} from '@/components/sidebar-panel';
import {Skeleton} from '@proxy/ui/components/skeleton';
import {useTitleBarHeader} from '@/hooks/use-title-bar-header';
import {type Later, Redirected} from '@/lib/loader-utils';
import {cn} from '@proxy/ui/lib/utils';

type Props = {
	// The page's content. It may read what the page's loader answers `later` (`useLoaded`): the
	// frame is up at once, and shows `waiting` in its place until the answer has come.
	children: ReactNode;
	// The title, where the page knows it before anything is loaded; otherwise the page
	// `loadsTitle`.
	title?: ReactNode;
	// The content names the page once loaded (`PageHeader`), as a page for one agent does; the
	// title's place is held until then.
	loadsTitle?: boolean;
	// The header's actions that need nothing of what the content loads; the content adds its own
	// (`PageHeader`).
	actions?: ReactNode;
	// What the page puts in the sidebar in the navigation's place, as Chat its agents, under a way
	// back up named `panelLabel`, as the page's item in the navigation is (sidebar-panel.tsx). It
	// is the frame's, so it stays as it is while the content loads.
	panel?: ReactNode;
	panelLabel?: string;
	// `inside`: the page is as tall as the window and scrolls a part of itself, as Chat scrolls its
	// log, so the header, the sidebars and the rest stay put, the overscroll bounce included.
	// Otherwise the whole page scrolls.
	scroll?: 'page' | 'inside';
	// What stands for the content while it loads; rows of a list, unless the page has its own.
	waiting?: ReactNode;
};

// Where in the header the content puts what only it knows, once loaded: the title and its
// actions. Null until the frame has drawn them, and where it has none.
type Slots = {title: HTMLElement | null; actions: HTMLElement | null};

const FrameSlots = createContext<Slots>({title: null, actions: null});

/**
 * From a page's content: the header's title, on a page that `loadsTitle`, and its actions, which
 * need what the content loaded or open what it holds, as a dialog.
 */
export function PageHeader({title, actions}: {title?: ReactNode; actions?: ReactNode}) {
	const slots = useContext(FrameSlots);
	return (
		<>
			{title !== undefined && slots.title && createPortal(title, slots.title)}
			{actions !== undefined && slots.actions && createPortal(actions, slots.actions)}
		</>
	);
}

// What stands for something loading shows only once the loading has taken a moment, 350 ms, so
// what comes sooner is not preceded by a flash of it: it fades in then, or, with less motion asked
// for, is there at once.
const LATE = 'animate-in delay-350 duration-200 fill-mode-both fade-in-0 motion-reduce:duration-0';

// What stands for a page's content while it loads: the rows of a list. On a page that scrolls
// inside, which lays out its own column, it lays out one as well.
function Waiting({column}: {column: boolean}) {
	return (
		<div
			role="status"
			aria-label="Loading"
			className={cn(
				'flex w-full flex-col gap-4',
				LATE,
				column && 'page-column mx-auto max-w-3xl pt-6',
			)}
		>
			<Skeleton className="h-5 w-40" />
			<div className="flex flex-col gap-2">
				<Skeleton className="h-10" />
				<Skeleton className="h-10" />
				<Skeleton className="h-10" />
				<Skeleton className="h-10 w-2/3" />
			</div>
		</div>
	);
}

/** What stands for a title that has not loaded yet. */
export function TitleWaiting() {
	return (
		<div className={LATE}>
			<Skeleton className="h-4 w-40" />
		</div>
	);
}

/** What stands for a panel's content that has not loaded yet. */
export function PanelWaiting() {
	return (
		<div aria-hidden className={cn('flex flex-col gap-2 p-3', LATE)}>
			<Skeleton className="h-12" />
			<Skeleton className="h-12" />
			<Skeleton className="h-12" />
		</div>
	);
}

// A loader answering `later` (loader-utils.ts) may answer with a redirect, as to sign-in once
// signed out, after its page has opened. The frame, there before any answer, follows it.
function useFollowRedirect() {
	const answer = useLoaderData<Partial<Later<object>> | undefined>()?.later;
	const navigate = useNavigate();
	useEffect(() => {
		if (!answer) {
			return;
		}
		let left = false;
		// A failure is the content's to say (`useLoaded`).
		const follow = (answered: object) => {
			if (!left && answered instanceof Redirected) {
				void navigate(answered.to, {replace: true});
			}
		};
		answer.then(follow, () => undefined);
		return () => {
			left = true;
		};
	}, [answer, navigate]);
}

// The human side's frame beside its sidebar (HumanSide): a header with the page's title and
// actions, the title bar's cell over the page's column, and the page's content in one centered
// column. The frame is up as soon as the page opens; content that has to load first shows when it
// has, and until then what stands for it.
export function AppShell({
	children,
	title,
	loadsTitle = false,
	actions,
	panel,
	panelLabel = 'Panel',
	scroll = 'page',
	waiting,
}: Props) {
	const {pathname} = useLocation();
	const titleBarHeader = useTitleBarHeader();
	const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
	const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
	const slots = useMemo(() => ({title: titleSlot, actions: actionsSlot}), [titleSlot, actionsSlot]);
	useFollowRedirect();
	const heading = loadsTitle ? <span ref={setTitleSlot} className="contents" /> : title;

	return (
		<FrameSlots value={slots}>
			{panel !== undefined && <InSidebar label={panelLabel}>{panel}</InSidebar>}
			<div
				data-page
				className={cn(
					'relative flex w-full min-w-0 flex-1 flex-col bg-background text-foreground',
					scroll === 'inside' ? 'h-dvh overflow-hidden' : 'min-h-dvh',
				)}
			>
				{/* Sticky only when the window scrolls. It is the title bar's cell over the page's
				    column (index.css). */}
				<header
					ref={titleBarHeader}
					className={cn(
						'z-20 flex shrink-0 items-center justify-between gap-4 border-b bg-background pr-4',
						scroll === 'page' && 'sticky top-0',
					)}
				>
					<div className="flex min-w-0 flex-1 items-center gap-2">{heading}</div>
					<div className="flex shrink-0 items-center gap-2">
						{actions}
						<div ref={setActionsSlot} className="contents" />
					</div>
				</header>
				<main
					className={cn(
						'flex w-full flex-1 flex-col',
						// Scrolling inside, the page lays out its own column, so its scroller can
						// reach the window's edge.
						scroll === 'inside' ? 'min-h-0' : 'page-column mx-auto max-w-3xl gap-4 pt-6 pb-12',
					)}
				>
					{/* Each address has its own content, and its own failure. */}
					<Suspense
						key={pathname}
						fallback={
							<>
								{loadsTitle && <PageHeader title={<TitleWaiting />} />}
								{waiting ?? <Waiting column={scroll === 'inside'} />}
							</>
						}
					>
						<ContentBoundary key={pathname}>{children}</ContentBoundary>
					</Suspense>
				</main>
			</div>
		</FrameSlots>
	);
}

// The header's title: the page's name, with an optional muted detail beside it.
export function PageTitle({children, detail}: {children: ReactNode; detail?: ReactNode}) {
	return (
		<>
			<span className="truncate text-sm font-medium">{children}</span>
			{detail !== undefined && (
				<span className="hidden truncate text-sm text-muted-foreground tabular-nums md:inline">
					{detail}
				</span>
			)}
		</>
	);
}

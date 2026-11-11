import {PillButton} from '@proxy/ui/components/pill-button';
import {cn} from '@proxy/ui/lib/utils';
import {ArrowDownIcon} from 'lucide-react';
import {
	type ComponentProps,
	createContext,
	type KeyboardEvent,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type WheelEvent,
} from 'react';

// A chat's scroller. It opens at the end and follows it as more comes, until the person scrolls
// up; scrolling back to the end follows it again. What the person sends (an item marked
// `scrollAnchor` that comes after the chat opened) is pinned to the top of the view, a little of
// what came before it showing above it, with room made under it where the chat is too short, so
// what answers it is read from its start. It is let go of as the person scrolls.
//
// Every correction lands before the browser paints: as items come (in a layout effect) and as
// anything changes size (in the ResizeObserver's callback, which runs after layout and before
// paint), never a frame later, so no frame shows the chat out of place. What the person did is
// told from the chat's own scrolling by their input: a wheel, a key, a touch or a pointer held
// on the scroller, a moment before the scroll.

// Within this of the end, the view is at the end.
const END_SLACK_PX = 8;
// How far under the top of the view a pinned item sits, a little of what came before it showing
// above it.
const PEEK_PX = 88;
// How long after the person's input a scroll is theirs.
const USER_INPUT_MS = 250;
// The keys that scroll the view.
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

// Following the end; keeping a pinned item at the top; or left where the person scrolled to.
type Mode = 'follow' | 'pinned' | 'free';

type Scroller = {
	// The scroller's parts, as they are drawn.
	setViewport: (element: HTMLDivElement | null) => void;
	setContent: (element: HTMLDivElement | null) => void;
	setSpacer: (element: HTMLDivElement | null) => void;
	// Whether the chat has opened: items that come after it are new.
	isOpen: () => boolean;
	// Pins an item that just came to the top of the view.
	pin: (item: HTMLElement) => void;
	// Scrolls to the end, and follows it.
	scrollToEnd: (behavior: ScrollBehavior) => void;
	// The person's input on the scroller, and their scrolling.
	input: () => void;
	hold: (held: boolean) => void;
	scrolled: () => void;
	// Puts the view where it belongs after anything came or changed size.
	settle: () => void;
};

const ScrollerContext = createContext<Scroller | null>(null);
// Whether there is more below the view than the scroller follows.
const MoreBelowContext = createContext(false);

function useScroller(): Scroller {
	const scroller = useContext(ScrollerContext);
	if (scroller === null) {
		throw new Error('A part of the message scroller is outside a MessageScroller.');
	}
	return scroller;
}

// Where an element starts in the viewport's scrolled content.
function topOf(element: HTMLElement, viewport: HTMLElement): number {
	return (
		element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
	);
}

function MessageScroller({className, children, ...props}: ComponentProps<'div'>) {
	const viewport = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const spacer = useRef<HTMLDivElement>(null);
	const opened = useRef(false);
	const mode = useRef<Mode>('follow');
	const pinned = useRef<HTMLElement | null>(null);
	const lastInput = useRef(Number.NEGATIVE_INFINITY);
	const held = useRef(false);
	const lastTop = useRef(0);
	const [moreBelow, setMoreBelow] = useState(false);

	const scroller = useMemo((): Scroller => {
		// Says whether there is more below the view, where the scroller isn't following the end.
		const note = () => {
			const view = viewport.current;
			if (view === null) {
				return;
			}
			const distance = view.scrollHeight - view.scrollTop - view.clientHeight;
			setMoreBelow(mode.current !== 'follow' && distance > END_SLACK_PX);
		};

		// The room under the pinned item: as much as scrolling it to the top of the view needs,
		// less as what comes after it fills the view. While an item is pinned the chat is never
		// shorter than that, so nothing shrinking under it moves it.
		const makeRoom = () => {
			const view = viewport.current;
			const list = content.current;
			const room = spacer.current;
			if (view === null || list === null || room === null) {
				return;
			}
			const item = pinned.current;
			if (item === null || !item.isConnected) {
				pinned.current = null;
				room.style.height = '0px';
				return;
			}
			const end = list.getBoundingClientRect().bottom - view.getBoundingClientRect().top;
			const needed = topOf(item, view) - PEEK_PX + view.clientHeight - (end + view.scrollTop);
			room.style.height = `${Math.max(0, Math.ceil(needed))}px`;
		};

		// Puts the view where the mode says, after anything came or changed size.
		const settle = () => {
			const view = viewport.current;
			if (view === null) {
				return;
			}
			makeRoom();
			if (mode.current === 'follow') {
				view.scrollTop = view.scrollHeight;
			}
			if (mode.current === 'pinned' && pinned.current !== null) {
				view.scrollTop = topOf(pinned.current, view) - PEEK_PX;
			}
			lastTop.current = view.scrollTop;
			note();
		};

		return {
			setViewport: (element) => {
				viewport.current = element;
			},
			setContent: (element) => {
				content.current = element;
			},
			setSpacer: (element) => {
				spacer.current = element;
			},
			isOpen: () => opened.current,
			pin: (item) => {
				pinned.current = item;
				mode.current = 'pinned';
				settle();
			},
			scrollToEnd: (behavior) => {
				const view = viewport.current;
				if (view === null) {
					return;
				}
				pinned.current = null;
				mode.current = 'follow';
				makeRoom();
				view.scrollTo({top: view.scrollHeight, behavior});
				note();
			},
			input: () => {
				lastInput.current = performance.now();
			},
			hold: (holding) => {
				held.current = holding;
			},
			// A scroll the person made lets go of a pinned item, and of the end where it went up;
			// one that reaches the end follows it again. The scroller's own scrolling changes nothing.
			scrolled: () => {
				const view = viewport.current;
				if (view === null) {
					return;
				}
				const moved = view.scrollTop - lastTop.current;
				lastTop.current = view.scrollTop;
				const theirs = held.current || performance.now() - lastInput.current < USER_INPUT_MS;
				if (theirs && moved !== 0) {
					if (moved < 0 || mode.current === 'pinned') {
						mode.current = 'free';
					}
					const distance = view.scrollHeight - view.scrollTop - view.clientHeight;
					if (mode.current === 'free' && distance <= END_SLACK_PX) {
						mode.current = 'follow';
					}
				}
				note();
			},
			settle,
		};
	}, []);

	// Opens at the end, before the first paint, and settles again, before paint, as the view or
	// what is in it changes size.
	useLayoutEffect(() => {
		const view = viewport.current;
		const list = content.current;
		if (view === null || list === null) {
			return;
		}
		mode.current = 'follow';
		pinned.current = null;
		view.scrollTop = view.scrollHeight;
		lastTop.current = view.scrollTop;
		opened.current = true;
		const observer =
			typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => scroller.settle());
		observer?.observe(view);
		observer?.observe(list);
		// Undone as it is taken down, or run again (as React's strict mode does): the items it
		// opens with are not new.
		return () => {
			opened.current = false;
			observer?.disconnect();
		};
	}, [scroller]);

	// A pointer held on the scroller is the person scrolling (its scrollbar, or a selection) until
	// it is let go, wherever that is.
	useEffect(() => {
		const release = () => scroller.hold(false);
		window.addEventListener('pointerup', release);
		window.addEventListener('pointercancel', release);
		return () => {
			window.removeEventListener('pointerup', release);
			window.removeEventListener('pointercancel', release);
		};
	}, [scroller]);

	return (
		<ScrollerContext.Provider value={scroller}>
			<MoreBelowContext.Provider value={moreBelow}>
				<div
					data-slot="message-scroller"
					className={cn('relative flex size-full min-h-0 flex-col overflow-hidden', className)}
					{...props}
				>
					{children}
				</div>
			</MoreBelowContext.Provider>
		</ScrollerContext.Provider>
	);
}

// The viewport fades out at its bottom while there is more below. A browser that can drive the
// fade from the scroll position does (shadcn's scroll-fade); for one that can't, the viewport
// says whether it is scrolled to the end, and the stylesheet lifts the fade there. It takes focus
// so the arrow keys scroll it, but shows no outline for it: clicking into the conversation would
// otherwise frame the whole of it.
function MessageScrollerViewport({
	className,
	children,
	'aria-label': label = 'Messages',
	...props
}: ComponentProps<'div'>) {
	const {setViewport, scrolled, input, hold} = useScroller();
	const moreBelow = useContext(MoreBelowContext);
	return (
		<div
			ref={setViewport}
			role="region"
			aria-label={label}
			tabIndex={0}
			data-slot="message-scroller-viewport"
			data-scrollable-end={moreBelow}
			onScroll={scrolled}
			onWheel={(event: WheelEvent) => {
				if (!event.ctrlKey) {
					input();
				}
			}}
			onTouchMove={input}
			onKeyDown={(event: KeyboardEvent) => {
				if (SCROLL_KEYS.has(event.key)) {
					input();
				}
			}}
			onPointerDown={() => {
				input();
				hold(true);
			}}
			className={cn(
				'size-full min-h-0 min-w-0 scroll-fade-b overflow-y-auto overscroll-contain scrollbar-thin scrollbar-gutter-stable outline-none contain-content',
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

// What is in the chat, and under it the room a pinned item may need, which the scroller sizes.
function MessageScrollerContent({className, ...props}: ComponentProps<'div'>) {
	const {setContent, setSpacer} = useScroller();
	return (
		<>
			<div
				ref={setContent}
				role="log"
				aria-relevant="additions"
				data-slot="message-scroller-content"
				className={cn('flex h-max min-h-full flex-col gap-6', className)}
				{...props}
			/>
			<div ref={setSpacer} aria-hidden data-slot="message-scroller-spacer" />
		</>
	);
}

// An item of the chat. The browser skips drawing one out of view. One marked `scrollAnchor` that
// comes after the chat opened is pinned to the top of the view as it comes.
function MessageScrollerItem({
	className,
	scrollAnchor = false,
	...props
}: ComponentProps<'div'> & {scrollAnchor?: boolean}) {
	const scroller = useScroller();
	const item = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (!scrollAnchor || !scroller.isOpen() || item.current === null) {
			return;
		}
		scroller.pin(item.current);
	}, [scrollAnchor, scroller]);
	return (
		<div
			ref={item}
			data-slot="message-scroller-item"
			className={cn(
				'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
				className,
			)}
			{...props}
		/>
	);
}

// Scrolls to the end, smoothly unless the person would rather not see motion; there while there is
// more below than the scroller follows.
function MessageScrollerButton({className}: {className?: string}) {
	const scroller = useScroller();
	const active = useContext(MoreBelowContext);
	return (
		<PillButton
			variant="ghost"
			icon
			data-slot="message-scroller-button"
			data-active={active}
			inert={!active}
			tabIndex={active ? 0 : -1}
			onClick={(event) => {
				event.currentTarget.blur();
				const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
				scroller.scrollToEnd(still ? 'auto' : 'smooth');
			}}
			className={cn(
				'absolute bottom-4 inset-s-1/2 -translate-x-1/2 rounded-full border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] rtl:translate-x-1/2',
				className,
			)}
		>
			<ArrowDownIcon />
			<span className="sr-only">Scroll to end</span>
		</PillButton>
	);
}

export {
	MessageScroller,
	MessageScrollerViewport,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerButton,
};

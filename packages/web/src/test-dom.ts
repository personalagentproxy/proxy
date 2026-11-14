import {jest} from 'bun:test';
import {Window} from 'happy-dom';
import {log} from './lib/log';

// Navigating the window is off: a page that sends the browser elsewhere, as the desktop pages do
// with their app links, would otherwise move every later test's window to it, leaving
// `location.origin` as "null" for them, at a time that depends on the order the files run in.
export const testWindow = new Window({
	url: 'http://localhost/',
	settings: {
		device: {prefersColorScheme: 'light'},
		navigation: {disableMainFrameNavigation: true, disableFallbackToSetURL: true},
	},
});

Object.assign(globalThis, {
	window: testWindow,
	document: testWindow.document,
	navigator: testWindow.navigator,
	localStorage: testWindow.localStorage,
	Element: testWindow.Element,
	HTMLElement: testWindow.HTMLElement,
	HTMLInputElement: testWindow.HTMLInputElement,
	HTMLTextAreaElement: testWindow.HTMLTextAreaElement,
	SVGElement: testWindow.SVGElement,
	Node: testWindow.Node,
	Event: testWindow.Event,
	StorageEvent: testWindow.StorageEvent,
	MouseEvent: testWindow.MouseEvent,
	MutationObserver: testWindow.MutationObserver,
	ResizeObserver: testWindow.ResizeObserver,
	DOMRect: testWindow.DOMRect,
	getComputedStyle: testWindow.getComputedStyle.bind(testWindow),
	requestAnimationFrame: testWindow.requestAnimationFrame.bind(testWindow),
	cancelAnimationFrame: testWindow.cancelAnimationFrame.bind(testWindow),
});

// Testing Library tells fake timers by a global `jest`, as Jest has: Bun's `jest.useFakeTimers()`
// fakes the clock, and with this, waiting for something moves that clock on as it looks again,
// rather than waiting on a clock that only a test moves.
Object.assign(globalThis, {jest});

// The app's log posts what it has every 5 seconds, from whatever test is running then: an error
// one file logs on purpose would take a fetch another file's test answers. Shut down before any
// test logs, it posts nothing; what it writes to the console it still writes.
log.shutdown();

import {Window} from 'happy-dom';

// Navigating the window is off: a page that sends the browser elsewhere, as the desktop pages do
// with their app links, would otherwise move every later test's window to it, leaving
// `location.origin` as "null" for them, at a time that depends on the order the files run in.
export const testWindow = new Window({
	url: 'http://localhost/',
	settings: {
		device: {prefersColorScheme: 'light'},
		navigation: {disableMainFrameNavigation: true},
	},
});

Object.assign(globalThis, {
	window: testWindow,
	document: testWindow.document,
	navigator: testWindow.navigator,
	localStorage: testWindow.localStorage,
	Element: testWindow.Element,
	HTMLElement: testWindow.HTMLElement,
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

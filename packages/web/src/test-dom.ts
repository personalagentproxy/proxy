import {Window} from 'happy-dom';

export const testWindow = new Window({
	url: 'http://localhost/',
	settings: {device: {prefersColorScheme: 'light'}},
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

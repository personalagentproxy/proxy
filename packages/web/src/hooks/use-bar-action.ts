import {useEffect, useLayoutEffect, useRef, useState} from 'react';

/**
 * What the command bar hands a widget that does something for good once Enter is pressed in the
 * bar's input, as sending a message to an agent or making one: the widget says what Enter does,
 * and the bar says when it was pressed and takes the person where the widget leads.
 */
export type BarAction = {
	// Enter was pressed for the text the widget is for before it showed, so it acts at once.
	entered: boolean;
	// Whether Enter in the bar's input is the widget's, to say so on its button: not while the bar
	// lists somewhere to go, which Enter opens.
	onEnter: boolean;
	// The widget's action for Enter in the bar's input; null while it has none to do.
	setAction: (act: (() => void) | null) => void;
	// It is done: the bar folds away, and the app goes `to`.
	done: (to: string) => void;
};

/**
 * A widget's action as the bar's: Enter in the bar's input does `act` while it is `ready`, and
 * where Enter was pressed before the widget showed, and it showed ready, `act` is done once, at
 * once.
 */
export function useBarAction(bar: BarAction, act: () => void, ready: boolean) {
	const latest = useRef(act);
	useLayoutEffect(() => {
		latest.current = act;
	});
	// As the widget first showed: something it only becomes ready for later, as a name typed in,
	// waits for Enter again.
	const [atOnce] = useState(bar.entered && ready);
	const done = useRef(false);
	const {setAction} = bar;

	// Said as the widget is drawn, not a moment after: Enter pressed the instant it shows is its.
	useLayoutEffect(() => {
		if (!ready) {
			return;
		}
		setAction(() => latest.current());
		return () => setAction(null);
	}, [ready, setAction]);

	useEffect(() => {
		if (!atOnce || done.current) {
			return;
		}
		done.current = true;
		latest.current();
	}, [atOnce]);
}

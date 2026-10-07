import type {ReactNode} from 'react';

// Numbers the h3s inside it as steps, on a line down the left. globals.css draws the numbers.
export function Steps({children}: {children: ReactNode}) {
	return <div className="steps my-6 ml-3 border-l pl-7">{children}</div>;
}

/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {useState} from 'react';
import {type ShownText, TextPanel, TextSwitch} from '@/components/goal-and-outcome';

afterEach(cleanup);

// The two as a page holds them: the switch choosing what the panel shows.
function Both({goal = 'Plan the week', outcome}: {goal?: string; outcome: string | null}) {
	const [shown, setShown] = useState<ShownText>('goal');
	return (
		<>
			<TextSwitch id="text" shown={shown} hasOutcome={outcome !== null} onChange={setShown} />
			<TextPanel id="text" shown={shown} goal={goal} outcome={outcome} />
		</>
	);
}

describe('TextSwitch and TextPanel', () => {
	test('show the description, and the outcome once switched to', () => {
		render(<Both outcome="Tuesday is the day to start" />);

		expect(screen.getByRole('tabpanel').textContent).toBe('Plan the week');
		expect(screen.getByRole('tab', {name: 'Description'}).getAttribute('aria-selected')).toBe(
			'true',
		);

		fireEvent.click(screen.getByRole('tab', {name: 'Outcome'}));

		expect(screen.getByRole('tabpanel').textContent).toBe('Tuesday is the day to start');
		expect(screen.getByRole('tab', {name: 'Outcome'}).getAttribute('aria-selected')).toBe('true');
	});

	test('renders Markdown in the description and outcome', () => {
		render(
			<Both
				goal={
					'Plan the **week** with [the team](https://example.com/team).\n\n![Tracking pixel](https://example.com/pixel.png)'
				}
				outcome={'Finished the plan:\n\n- Monday\n- Tuesday'}
			/>,
		);

		expect(screen.getByText('week').tagName).toBe('STRONG');
		expect(screen.getByRole('link', {name: 'the team'}).getAttribute('href')).toBe(
			'https://example.com/team',
		);
		expect(screen.getByText('Tracking pixel').tagName).toBe('SPAN');
		expect(screen.queryByRole('img')).toBeNull();

		fireEvent.click(screen.getByRole('tab', {name: 'Outcome'}));

		expect(screen.getByText('Monday').tagName).toBe('LI');
		expect(screen.getByText('Tuesday').tagName).toBe('LI');
	});

	test('the arrow keys move between the two, and the panel is named by the tab shown', () => {
		render(<Both outcome="Tuesday is the day to start" />);
		const description = screen.getByRole('tab', {name: 'Description'});
		const outcome = screen.getByRole('tab', {name: 'Outcome'});
		expect([description.tabIndex, outcome.tabIndex]).toEqual([0, -1]);
		expect(description.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);

		fireEvent.keyDown(description, {key: 'ArrowRight'});

		expect(outcome.getAttribute('aria-selected')).toBe('true');
		expect([description.tabIndex, outcome.tabIndex]).toEqual([-1, 0]);
		expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(outcome.id);
		expect(document.activeElement).toBe(outcome);
	});

	test('a task without an outcome has only its description, and the switch can’t be moved', () => {
		render(<Both goal="Plan the **week**" outcome={null} />);

		expect(screen.getByText('week').tagName).toBe('STRONG');
		const outcome = screen.getByRole('tab', {name: 'Outcome'});
		expect(outcome.getAttribute('aria-disabled')).toBe('true');

		fireEvent.click(outcome);

		expect(screen.getByText('week').tagName).toBe('STRONG');
		expect(screen.getByRole('tab', {name: 'Description'}).getAttribute('aria-selected')).toBe(
			'true',
		);
	});
});

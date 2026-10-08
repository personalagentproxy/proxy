'use client';

import {useState} from 'react';

// The variables `.logo-tile` in globals.css scales its effects by, 1 being as tuned.
const SETTINGS = [
	{name: '--logo-shadow', label: 'Shadow'},
	{name: '--logo-shadow-size', label: 'Shadow size'},
	{name: '--logo-glow', label: 'Glow'},
] as const;

type Values = Record<(typeof SETTINGS)[number]['name'], number>;

const DEFAULTS: Values = {'--logo-shadow': 1, '--logo-shadow-size': 1, '--logo-glow': 1};

// Development only: sliders for the dock's tile effects, set live on the page's root. Once they
// look right, the values go into globals.css.
export function LogoDockTuner() {
	const [values, setValues] = useState(DEFAULTS);

	const set = (next: Values) => {
		setValues(next);
		for (const setting of SETTINGS) {
			document.documentElement.style.setProperty(setting.name, String(next[setting.name]));
		}
	};

	return (
		<div className="fixed right-4 bottom-4 z-50 grid w-64 gap-3 rounded-xl border bg-background p-4 text-sm shadow-lg">
			<div className="flex justify-between">
				<span className="font-medium">Logo tiles</span>
				<button
					className="text-muted-foreground hover:text-foreground"
					onClick={() => set(DEFAULTS)}
				>
					Reset
				</button>
			</div>
			{SETTINGS.map((setting) => (
				<label key={setting.name} className="grid gap-1">
					<span className="flex justify-between text-muted-foreground">
						{setting.label}
						<span className="tabular-nums">{values[setting.name].toFixed(2)}</span>
					</span>
					<input
						type="range"
						className="accent-primary"
						min={0}
						max={3}
						step={0.05}
						value={values[setting.name]}
						onChange={(event) => set({...values, [setting.name]: Number(event.target.value)})}
					/>
				</label>
			))}
		</div>
	);
}

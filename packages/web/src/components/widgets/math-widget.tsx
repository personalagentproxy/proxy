import {CalculatorIcon} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import {CopyButton} from '@/components/copy-button';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {calculate, formatNumber} from '@/lib/calculate';
import {fieldTexts} from '@/lib/widget-values';

// Math: the calculation the model read from what was typed, worked out here, since a model gets
// arithmetic wrong, with the answer to copy.
export function MathWidget({intent}: {intent: Intent}) {
	const [expression] = fieldTexts(intent, 'expression');
	const result = expression ? calculate(expression) : null;

	return (
		<WidgetFrame icon={CalculatorIcon} name="Math">
			{!expression && <Missing>Type a calculation</Missing>}
			{expression && result === null && <Missing>Can’t work out “{expression}”</Missing>}
			{expression && result !== null && (
				<div className="flex items-end justify-between gap-3">
					<div className="min-w-0">
						<p className="truncate text-muted-foreground">{expression} =</p>
						<p className="truncate text-2xl font-medium tabular-nums" aria-label="Result">
							{formatNumber(result)}
						</p>
					</div>
					<CopyButton value={String(Number(result.toPrecision(12)))} label="Copy result" />
				</div>
			)}
		</WidgetFrame>
	);
}

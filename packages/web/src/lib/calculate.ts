/**
 * A calculation as the Math widget's model writes it, worked out here rather than by the model,
 * which gets arithmetic wrong: numbers, + - * / ^ (× ÷ too), parentheses, % for percent (`18% *
 * 86.40`), ! for a factorial, pi and e, and sqrt, cbrt, abs, round, floor, ceil, exp, ln, log (base
 * 10), log2, sin, cos, tan, asin, acos, atan (in radians), min and max. Nothing in it is ever run
 * as code. Null for anything else, or a result that isn't a number, as a division by zero isn't.
 */

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
	sqrt: Math.sqrt,
	cbrt: Math.cbrt,
	abs: Math.abs,
	round: Math.round,
	floor: Math.floor,
	ceil: Math.ceil,
	exp: Math.exp,
	ln: Math.log,
	log: Math.log10,
	log2: Math.log2,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	min: Math.min,
	max: Math.max,
};

const CONSTANTS: Record<string, number> = {pi: Math.PI, π: Math.PI, e: Math.E};

type Token =
	{kind: 'number'; value: number} | {kind: 'name'; value: string} | {kind: 'symbol'; value: string};

function tokens(text: string): Token[] | null {
	const found: Token[] = [];
	const pattern =
		/\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?|([a-zπ][a-z0-9]*)|([-+*/^%!(),×÷]))/giy;
	let index = 0;
	while (index < text.length) {
		pattern.lastIndex = index;
		const match = pattern.exec(text);
		if (!match || match[0] === '') {
			return text.slice(index).trim() === '' ? found : null;
		}
		index = pattern.lastIndex;
		const [, digits, exponent, name, symbol] = match;
		if (digits !== undefined) {
			found.push({
				kind: 'number',
				value: Number(`${digits}${exponent === undefined ? '' : `e${exponent}`}`),
			});
		}
		if (name !== undefined) {
			found.push({kind: 'name', value: name.toLowerCase()});
		}
		if (symbol !== undefined) {
			found.push({kind: 'symbol', value: symbol === '×' ? '*' : symbol === '÷' ? '/' : symbol});
		}
	}
	return found;
}

function factorial(value: number): number {
	if (!Number.isInteger(value) || value < 0 || value > 170) {
		return Number.NaN;
	}
	let product = 1;
	for (let factor = 2; factor <= value; factor++) {
		product *= factor;
	}
	return product;
}

// A recursive descent over the tokens, lowest precedence first: + and -, then * and /, then a
// sign, then ^ (to the right), then % and !, then a number, a name or parentheses. NaN where they
// don't make a calculation.
function parse(list: Token[]): number {
	let at = 0;
	const peek = () => list[at];
	const isSymbol = (value: string) => {
		const token = peek();
		return token?.kind === 'symbol' && token.value === value;
	};
	const take = (value: string) => {
		if (isSymbol(value)) {
			at++;
			return true;
		}
		return false;
	};

	const sum = (): number => {
		let value = product();
		for (;;) {
			if (take('+')) {
				value += product();
				continue;
			}
			if (take('-')) {
				value -= product();
				continue;
			}
			return value;
		}
	};
	const product = (): number => {
		let value = signed();
		for (;;) {
			if (take('*')) {
				value *= signed();
				continue;
			}
			if (take('/')) {
				value /= signed();
				continue;
			}
			return value;
		}
	};
	const signed = (): number => {
		if (take('-')) {
			return -signed();
		}
		if (take('+')) {
			return signed();
		}
		return power();
	};
	const power = (): number => {
		const base = postfix();
		return take('^') ? base ** signed() : base;
	};
	const postfix = (): number => {
		let value = primary();
		for (;;) {
			if (take('%')) {
				value /= 100;
				continue;
			}
			if (take('!')) {
				value = factorial(value);
				continue;
			}
			return value;
		}
	};
	const primary = (): number => {
		const token = peek();
		if (!token) {
			return Number.NaN;
		}
		if (token.kind === 'number') {
			at++;
			return token.value;
		}
		if (take('(')) {
			const value = sum();
			return take(')') ? value : Number.NaN;
		}
		if (token.kind !== 'name') {
			return Number.NaN;
		}
		at++;
		const fn = FUNCTIONS[token.value];
		if (!fn) {
			return CONSTANTS[token.value] ?? Number.NaN;
		}
		if (!take('(')) {
			return Number.NaN;
		}
		const args = [sum()];
		while (take(',')) {
			args.push(sum());
		}
		return take(')') ? fn(...args) : Number.NaN;
	};

	const value = sum();
	return at === list.length ? value : Number.NaN;
}

/** What `expression` comes to, or null where it isn't a calculation this reads. */
export function calculate(expression: string): number | null {
	const list = tokens(expression);
	if (!list || list.length === 0) {
		return null;
	}
	const value = parse(list);
	return Number.isFinite(value) ? value : null;
}

/**
 * A result as the widgets show it, to `digits` significant digits: 0.1 + 0.2 as 0.3, not
 * 0.30000000000000004; a conversion to fewer, 72 °F as 22.2222 °C.
 */
export function formatNumber(value: number, digits = 12): string {
	return new Intl.NumberFormat(undefined, {maximumSignificantDigits: digits}).format(value);
}

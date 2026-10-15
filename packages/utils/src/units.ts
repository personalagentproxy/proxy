/**
 * The units the home page's Convert units widget knows: the api offers their ids to the model to
 * pick from, so "miles", "mi." and "statute miles" are all `mi`, and the web app converts between
 * them. Each is a number of its kind's base unit (metres, grams, litres…), but temperatures,
 * which also move their zero, and currencies, whose worth is the day's exchange rate.
 */

export type UnitKind =
	| 'length'
	| 'mass'
	| 'volume'
	| 'temperature'
	| 'speed'
	| 'area'
	| 'time'
	| 'data'
	| 'energy'
	| 'currency';

/** What one euro is worth in each currency, by its code (`USD`): the European Central Bank's of a day. */
export type Rates = Record<string, number>;

// The currencies the European Central Bank publishes a rate for, and the euro.
const CURRENCIES: Array<[string, string]> = [
	['EUR', 'euro'],
	['USD', 'US dollar'],
	['GBP', 'British pound'],
	['JPY', 'Japanese yen'],
	['CHF', 'Swiss franc'],
	['CAD', 'Canadian dollar'],
	['AUD', 'Australian dollar'],
	['NZD', 'New Zealand dollar'],
	['CNY', 'Chinese yuan'],
	['HKD', 'Hong Kong dollar'],
	['SGD', 'Singapore dollar'],
	['INR', 'Indian rupee'],
	['KRW', 'South Korean won'],
	['IDR', 'Indonesian rupiah'],
	['MYR', 'Malaysian ringgit'],
	['PHP', 'Philippine peso'],
	['THB', 'Thai baht'],
	['SEK', 'Swedish krona'],
	['NOK', 'Norwegian krone'],
	['DKK', 'Danish krone'],
	['ISK', 'Icelandic króna'],
	['PLN', 'Polish złoty'],
	['CZK', 'Czech koruna'],
	['HUF', 'Hungarian forint'],
	['RON', 'Romanian leu'],
	['TRY', 'Turkish lira'],
	['ILS', 'Israeli shekel'],
	['ZAR', 'South African rand'],
	['BRL', 'Brazilian real'],
	['MXN', 'Mexican peso'],
];

export type Unit = {
	id: string;
	kind: UnitKind;
	// As a sentence writes it: "kilometre", "kilometres", and as a number is followed: "km".
	name: string;
	plural: string;
	symbol: string;
	// How many of the kind's base unit one is.
	factor: number;
	// What it is converted to when nothing is said: its metric or imperial counterpart.
	counterpart: string;
};

const unit = (
	id: string,
	kind: UnitKind,
	name: string,
	symbol: string,
	factor: number,
	counterpart: string,
	plural = `${name}s`,
): Unit => ({id, kind, name, plural, symbol, factor, counterpart});

export const UNITS: Unit[] = [
	// Length, in metres.
	unit('mm', 'length', 'millimetre', 'mm', 0.001, 'in'),
	unit('cm', 'length', 'centimetre', 'cm', 0.01, 'in'),
	unit('m', 'length', 'metre', 'm', 1, 'ft'),
	unit('km', 'length', 'kilometre', 'km', 1000, 'mi'),
	unit('in', 'length', 'inch', 'in', 0.0254, 'cm', 'inches'),
	unit('ft', 'length', 'foot', 'ft', 0.3048, 'm', 'feet'),
	unit('yd', 'length', 'yard', 'yd', 0.9144, 'm'),
	unit('mi', 'length', 'mile', 'mi', 1609.344, 'km'),
	unit('nmi', 'length', 'nautical mile', 'nmi', 1852, 'km'),
	// Mass, in grams.
	unit('mg', 'mass', 'milligram', 'mg', 0.001, 'g'),
	unit('g', 'mass', 'gram', 'g', 1, 'oz'),
	unit('kg', 'mass', 'kilogram', 'kg', 1000, 'lb'),
	unit('t', 'mass', 'tonne', 't', 1_000_000, 'lb'),
	unit('oz', 'mass', 'ounce', 'oz', 28.349523125, 'g'),
	unit('lb', 'mass', 'pound', 'lb', 453.59237, 'kg'),
	unit('st', 'mass', 'stone', 'st', 6350.29318, 'kg', 'stone'),
	// Volume, in litres; cups, pints, quarts, gallons and fluid ounces the US's.
	unit('ml', 'volume', 'millilitre', 'ml', 0.001, 'floz'),
	unit('l', 'volume', 'litre', 'l', 1, 'gal'),
	unit('m3', 'volume', 'cubic metre', 'm³', 1000, 'gal'),
	unit('tsp', 'volume', 'teaspoon', 'tsp', 0.00492892159375, 'ml'),
	unit('tbsp', 'volume', 'tablespoon', 'tbsp', 0.01478676478125, 'ml'),
	unit('floz', 'volume', 'fluid ounce', 'fl oz', 0.0295735295625, 'ml'),
	unit('cup', 'volume', 'cup', 'cup', 0.2365882365, 'ml'),
	unit('pt', 'volume', 'pint', 'pt', 0.473176473, 'l'),
	unit('qt', 'volume', 'quart', 'qt', 0.946352946, 'l'),
	unit('gal', 'volume', 'gallon', 'gal', 3.785411784, 'l'),
	// Temperature: converted by `convert` itself.
	unit('c', 'temperature', 'degree Celsius', '°C', 1, 'f', 'degrees Celsius'),
	unit('f', 'temperature', 'degree Fahrenheit', '°F', 1, 'c', 'degrees Fahrenheit'),
	unit('k', 'temperature', 'kelvin', 'K', 1, 'c', 'kelvin'),
	// Speed, in metres a second.
	unit('mps', 'speed', 'metre per second', 'm/s', 1, 'kmh', 'metres per second'),
	unit('kmh', 'speed', 'kilometre per hour', 'km/h', 1000 / 3600, 'mph', 'kilometres per hour'),
	unit('mph', 'speed', 'mile per hour', 'mph', 1609.344 / 3600, 'kmh', 'miles per hour'),
	unit('kn', 'speed', 'knot', 'kn', 1852 / 3600, 'kmh'),
	// Area, in square metres.
	unit('m2', 'area', 'square metre', 'm²', 1, 'ft2', 'square metres'),
	unit('km2', 'area', 'square kilometre', 'km²', 1_000_000, 'mi2', 'square kilometres'),
	unit('ft2', 'area', 'square foot', 'ft²', 0.09290304, 'm2', 'square feet'),
	unit('mi2', 'area', 'square mile', 'mi²', 2_589_988.110336, 'km2', 'square miles'),
	unit('ha', 'area', 'hectare', 'ha', 10_000, 'acre'),
	unit('acre', 'area', 'acre', 'ac', 4046.8564224, 'ha'),
	// Time, in seconds.
	unit('s', 'time', 'second', 's', 1, 'min'),
	unit('min', 'time', 'minute', 'min', 60, 'h'),
	unit('h', 'time', 'hour', 'h', 3600, 'min'),
	unit('d', 'time', 'day', 'd', 86_400, 'h'),
	unit('wk', 'time', 'week', 'wk', 604_800, 'd'),
	// Data, in bytes, a kilobyte a thousand of them.
	unit('b', 'data', 'byte', 'B', 1, 'kb'),
	unit('kb', 'data', 'kilobyte', 'kB', 1e3, 'mb'),
	unit('mb', 'data', 'megabyte', 'MB', 1e6, 'gb'),
	unit('gb', 'data', 'gigabyte', 'GB', 1e9, 'mb'),
	unit('tb', 'data', 'terabyte', 'TB', 1e12, 'gb'),
	// Energy, in joules; a calorie of food is a kilocalorie.
	unit('j', 'energy', 'joule', 'J', 1, 'cal'),
	unit('kj', 'energy', 'kilojoule', 'kJ', 1000, 'kcal'),
	unit('cal', 'energy', 'calorie', 'cal', 4.184, 'j'),
	unit('kcal', 'energy', 'kilocalorie', 'kcal', 4184, 'kj'),
	unit('kwh', 'energy', 'kilowatt-hour', 'kWh', 3_600_000, 'kj'),
	// Money, worth the day's rate: the dollar's counterpart the euro, every other's the dollar.
	...CURRENCIES.map(([code, name]) =>
		unit(code.toLowerCase(), 'currency', name, code, 1, code === 'USD' ? 'eur' : 'usd'),
	),
];

export function findUnit(id: string): Unit | undefined {
	return UNITS.find((candidate) => candidate.id === id);
}

// A temperature in Celsius, and back.
function toCelsius(value: number, from: string): number {
	if (from === 'f') {
		return ((value - 32) * 5) / 9;
	}
	if (from === 'k') {
		return value - 273.15;
	}
	return value;
}

function fromCelsius(value: number, to: string): number {
	if (to === 'f') {
		return (value * 9) / 5 + 32;
	}
	if (to === 'k') {
		return value + 273.15;
	}
	return value;
}

/**
 * `value` of one unit in another of its kind; null for two kinds, as kilograms in miles, and for
 * money without the day's `rates`, or a currency they have none for.
 */
export function convert(value: number, from: Unit, to: Unit, rates?: Rates): number | null {
	if (from.kind !== to.kind) {
		return null;
	}
	if (from.kind === 'currency') {
		const fromRate = rates?.[from.symbol];
		const toRate = rates?.[to.symbol];
		return fromRate && toRate ? (value / fromRate) * toRate : null;
	}
	if (from.kind === 'temperature') {
		return fromCelsius(toCelsius(value, from.id), to.id);
	}
	return (value * from.factor) / to.factor;
}

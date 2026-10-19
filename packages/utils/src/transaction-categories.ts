/**
 * The kinds of spending the home page's Transactions widget knows, Plaid's primary personal finance
 * categories: the api offers their ids to the model to pick from, so "restaurants", "eating out" and
 * "groceries" are all `FOOD_AND_DRINK`, and the web app filters a bank's transactions by them. Each
 * transaction a bank integration answers the widget with carries one of these ids, or none.
 */

export type TransactionCategory = {
	id: string;
	/** As a sentence writes it: "Food and drink". */
	name: string;
	/** What people call it, for the model: "restaurants, groceries, coffee, bars". */
	examples: string;
};

export const TRANSACTION_CATEGORIES: TransactionCategory[] = [
	{id: 'INCOME', name: 'Income', examples: 'paychecks, salary, dividends, interest earned'},
	{
		id: 'TRANSFER_IN',
		name: 'Transfers in',
		examples: 'deposits, money moved in from another account, refunds',
	},
	{
		id: 'TRANSFER_OUT',
		name: 'Transfers out',
		examples: 'money moved to another account, savings, investments, Venmo',
	},
	{
		id: 'LOAN_PAYMENTS',
		name: 'Loan payments',
		examples: 'mortgage, car loan, student loan and credit card payments',
	},
	{
		id: 'BANK_FEES',
		name: 'Bank fees',
		examples: 'overdraft, ATM and foreign transaction fees, interest charged',
	},
	{
		id: 'ENTERTAINMENT',
		name: 'Entertainment',
		examples: 'streaming, movies, concerts, games, sports events',
	},
	{
		id: 'FOOD_AND_DRINK',
		name: 'Food and drink',
		examples: 'restaurants, groceries, coffee, bars, delivery, eating out',
	},
	{
		id: 'GENERAL_MERCHANDISE',
		name: 'Shopping',
		examples: 'shopping, clothing, electronics, online stores, Amazon',
	},
	{
		id: 'HOME_IMPROVEMENT',
		name: 'Home improvement',
		examples: 'furniture, hardware, repairs, gardening',
	},
	{id: 'MEDICAL', name: 'Medical', examples: 'doctors, dentists, pharmacies, veterinarians, gyms'},
	{id: 'PERSONAL_CARE', name: 'Personal care', examples: 'hair, beauty, laundry'},
	{
		id: 'GENERAL_SERVICES',
		name: 'Services',
		examples: 'insurance, education, child care, accounting, postage, storage',
	},
	{
		id: 'GOVERNMENT_AND_NON_PROFIT',
		name: 'Government and non-profit',
		examples: 'taxes, donations, government fees',
	},
	{
		id: 'TRANSPORTATION',
		name: 'Transportation',
		examples: 'gas, parking, tolls, taxis, Uber, public transit',
	},
	{id: 'TRAVEL', name: 'Travel', examples: 'flights, hotels, rental cars, Airbnb'},
	{
		id: 'RENT_AND_UTILITIES',
		name: 'Rent and utilities',
		examples: 'rent, electricity, water, internet, phone bills',
	},
];

/** The category by its id, or none. */
export function findTransactionCategory(id: string): TransactionCategory | undefined {
	return TRANSACTION_CATEGORIES.find((category) => category.id === id);
}

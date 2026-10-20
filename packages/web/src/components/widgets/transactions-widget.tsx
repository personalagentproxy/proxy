import {findTransactionCategory} from '@proxy/utils/transaction-categories';
import {ReceiptTextIcon} from 'lucide-react';
import type {Intent} from '@/client/intent-client';
import type {BankAccount, BankTransaction} from '@/client/widgets-client';
import {CONNECT_BANK} from '@/components/widgets/balances-widget';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {
	filterTransactions,
	formatMoney,
	matchAccounts,
	rangeAsked,
	rangeBefore,
	rangeRead,
	totalsOf,
	type Total,
} from '@/lib/bank-values';
import {useTransactions} from '@/lib/widget-lookups';
import {fieldTexts, shortDay} from '@/lib/widget-values';

// What the widget lists at most.
const LIMIT = 8;

// Plaid has at most two years; a range and the same stretch before it have to fit in that.
const MAX_READ_DAYS = 730;

function flowOf(intent: Intent): 'in' | 'out' | null {
	const [flow] = fieldTexts(intent, 'flow');
	return flow === 'in' || flow === 'out' ? flow : null;
}

// "$412.30", or where money went both ways, "$412.30 out · $2,500.00 in".
function totalRead(total: Total, flow: 'in' | 'out' | null): string {
	if (flow === 'in' || total.out === 0) {
		return formatMoney(total.in, total.currency);
	}
	if (flow === 'out' || total.in === 0) {
		return formatMoney(total.out, total.currency);
	}
	return `${formatMoney(total.out, total.currency)} out · ${formatMoney(total.in, total.currency)} in`;
}

function accountLabel(account: BankAccount | undefined): string {
	if (!account) {
		return '';
	}
	return account.mask ? `${account.name} ••${account.mask}` : account.name;
}

// Transactions: the transactions of every bank over the days asked about, at a merchant, of a kind,
// in a direction and on an account where those are said, what they add up to against the same
// days before, and the newest of them. The days are read from the bank once; the rest is sifted here
// as the person types on.
export function TransactionsWidget({
	intent,
	typed,
	now,
}: {
	intent: Intent;
	typed: string;
	now: Date;
}) {
	const [merchant = null] = fieldTexts(intent, 'merchant');
	const [category = null] = fieldTexts(intent, 'category');
	const [accountSaid = null] = fieldTexts(intent, 'transactionAccount');
	const flow = flowOf(intent);
	const range = rangeAsked(typed, now);
	const before = rangeBefore(range);
	// The days asked about and the same before them, in one read, where the bank has that far back.
	const withBefore = Date.parse(range.to) - Date.parse(before.from) < MAX_READ_DAYS * 86_400_000;
	const readRange = {from: withBefore ? before.from : range.from, to: range.to};
	const read = useTransactions(readRange);
	const sources = read.data?.sources ?? [];

	if (read.data && sources.length === 0) {
		return (
			<ConnectWidget icon={ReceiptTextIcon} name="Transactions" collectionId="transactions">
				{CONNECT_BANK}
			</ConnectWidget>
		);
	}

	const accounts = read.data?.accounts ?? [];
	const all = read.data?.transactions ?? [];
	// A merchant no transaction has but an account is named for ("my sapphire") is the account, and
	// one no transaction has beside a kind ("groceries") is that kind said twice.
	const merchantIsAccount =
		merchant !== null && accountSaid === null && matchAccounts(accounts, merchant).length > 0;
	const merchantIsCategory =
		merchant !== null &&
		category !== null &&
		all.length > 0 &&
		filterTransactions(all, {
			range: readRange,
			merchant,
			category: null,
			flow: null,
			accountIds: null,
		}).length === 0;
	const matchedAccounts = matchAccounts(accounts, merchantIsAccount ? merchant : accountSaid);
	const accountIds =
		matchedAccounts.length > 0 ? matchedAccounts.map((account) => account.id) : null;
	const filter = {
		merchant: merchantIsAccount || merchantIsCategory ? null : merchant,
		category,
		flow,
		accountIds,
	};
	const found = filterTransactions(all, {...filter, range});
	const earlier = withBefore ? filterTransactions(all, {...filter, range: before}) : [];
	const totals = totalsOf(found);
	const earlierTotals = totalsOf(earlier);
	const categoryName = category ? findTransactionCategory(category)?.name : undefined;
	const lead =
		flow === 'in' ? 'Money in' : merchant || category || flow === 'out' ? 'Spent' : 'Transactions';
	const described = [
		...(filter.merchant ? [`${flow === 'in' ? 'from' : 'at'} ${filter.merchant}`] : []),
		...(categoryName ? [categoryName] : []),
		...(accountIds ? [matchedAccounts.map(accountLabel).join(', ')] : []),
	];
	const shown = found.slice(0, LIMIT);

	return (
		<WidgetFrame icon={ReceiptTextIcon} name="Transactions" failed={read.data?.failed}>
			<p className="truncate">
				<span className="text-muted-foreground">{lead} </span>
				{described.join(' · ')}
				{described.length > 0 && ' · '}
				{range.defaulted ? <Missing>{range.said}</Missing> : range.said}
			</p>
			{accountSaid && accounts.length > 0 && !accountIds && (
				<p className="text-muted-foreground">
					No account called “{accountSaid}”, so every account is searched.
				</p>
			)}
			{totals.length > 0 && (
				<div className="flex flex-col gap-1" aria-label="In all">
					{totals.map((total) => {
						const earlierTotal = earlierTotals.find((one) => one.currency === total.currency);
						return (
							<div
								key={total.currency}
								className="flex flex-wrap items-baseline justify-between gap-x-3"
							>
								<span className="text-2xl font-semibold tabular-nums">
									{totalRead(total, flow)}
								</span>
								<span className="text-muted-foreground">
									{total.count === 1 ? '1 transaction' : `${total.count} transactions`} ·{' '}
									{rangeRead(range)}
									{earlierTotal && ` · ${totalRead(earlierTotal, flow)} ${before.said}`}
								</span>
							</div>
						);
					})}
				</div>
			)}
			<ul className="flex flex-col" aria-label="Transactions">
				{found.length === 0 && (
					<li className="text-muted-foreground">
						{read.loading || !read.data ? 'Reading your bank…' : 'No transactions match.'}
					</li>
				)}
				{shown.map((transaction) => (
					<TransactionRow
						key={`${transaction.connectionId} ${transaction.id}`}
						transaction={transaction}
						// The kind and the account go without saying once they are asked for.
						withCategory={category === null}
						account={
							accounts.length > 1 && matchedAccounts.length !== 1
								? accounts.find((account) => account.id === transaction.accountId)
								: undefined
						}
					/>
				))}
				{found.length > shown.length && (
					<li className="text-muted-foreground">
						{found.length - shown.length === 1 ? '1 more' : `${found.length - shown.length} more`}
						{read.data?.more && ', of the newest the bank gave'}
					</li>
				)}
			</ul>
		</WidgetFrame>
	);
}

function TransactionRow({
	transaction,
	withCategory,
	account,
}: {
	transaction: BankTransaction;
	withCategory: boolean;
	account: BankAccount | undefined;
}) {
	const categoryName =
		withCategory && transaction.category
			? findTransactionCategory(transaction.category)?.name
			: undefined;
	const incoming = transaction.amount > 0;
	return (
		<li className="bleed flex h-10 min-w-0 items-center gap-3">
			<span className="min-w-0 flex-1 truncate">
				{transaction.merchant ?? transaction.name}
				{transaction.pending && <span className="text-muted-foreground"> · pending</span>}
			</span>
			{categoryName && (
				<span className="hidden w-32 shrink-0 truncate text-muted-foreground md:inline">
					{categoryName}
				</span>
			)}
			{account && (
				<span className="hidden w-44 shrink-0 truncate text-muted-foreground md:inline">
					{accountLabel(account)}
				</span>
			)}
			<span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
				{shortDay(new Date(`${transaction.date}T00:00`))}
			</span>
			<span className={`w-24 shrink-0 text-right tabular-nums ${incoming ? 'font-medium' : ''}`}>
				{incoming ? '+' : ''}
				{formatMoney(Math.abs(transaction.amount), transaction.currency)}
			</span>
		</li>
	);
}

import {LandmarkIcon} from 'lucide-react';
import {useState} from 'react';
import type {Intent} from '@/client/intent-client';
import type {BankAccount, Source} from '@/client/widgets-client';
import {ConnectWidget} from '@/components/widgets/connect-widget';
import {Missing, WidgetFrame} from '@/components/widgets/widget-frame';
import {formatMoney, matchAccounts} from '@/lib/bank-values';
import {useAccounts} from '@/lib/widget-lookups';
import {fieldTexts} from '@/lib/widget-values';

/** What a widget asks for when nothing is connected to read. */
export const CONNECT_BANK = 'Connect a bank to see your balances and spending from here.';

// "Checking ••0000 · $100.00 available": what can be spent now, or on a card what credit is left,
// where the bank says and it isn't the balance itself.
function detailOf(account: BankAccount): string {
	const kind = [account.type, account.mask ? `••${account.mask}` : ''].filter(Boolean).join(' ');
	if (account.available !== null && account.available !== account.balance) {
		return `${kind} · ${formatMoney(account.available, account.currency)} available`;
	}
	return kind;
}

// What the accounts hold and owe, per currency: "In accounts $1,110.00 · Owed $410.00".
function sumsOf(accounts: BankAccount[]): string[] {
	const byCurrency = new Map<string, {held: number; owed: number}>();
	for (const account of accounts) {
		if (account.balance === null) {
			continue;
		}
		const sum = byCurrency.get(account.currency) ?? {held: 0, owed: 0};
		sum[account.owed ? 'owed' : 'held'] += account.balance;
		byCurrency.set(account.currency, sum);
	}
	return [...byCurrency.entries()].map(([currency, sum]) =>
		[
			...(sum.held !== 0 || sum.owed === 0
				? [`In accounts ${formatMoney(sum.held, currency)}`]
				: []),
			...(sum.owed !== 0 ? [`Owed ${formatMoney(sum.owed, currency)}`] : []),
		].join(' · '),
	);
}

// Balances: every account of every bank connected, what each holds or owes, and their sums. Asked
// about one account, that one stands out and the rest fold away.
export function BalancesWidget({intent}: {intent: Intent}) {
	const [said = null] = fieldTexts(intent, 'balanceAccount');
	const read = useAccounts(true);
	const [unfolded, setUnfolded] = useState(false);
	const sources = read.data?.sources ?? [];

	if (read.data && sources.length === 0) {
		return (
			<ConnectWidget icon={LandmarkIcon} name="Balances" collectionId="accounts">
				{CONNECT_BANK}
			</ConnectWidget>
		);
	}

	const accounts = read.data?.accounts ?? [];
	const matched = matchAccounts(accounts, said);
	const folded =
		matched.length > 0 && !unfolded ? accounts.filter((account) => !matched.includes(account)) : [];
	const shown = accounts.filter((account) => !folded.includes(account));
	const banks = sources.length > 1 ? sources : [];

	return (
		<WidgetFrame icon={LandmarkIcon} name="Balances" failed={read.data?.failed}>
			<p className="truncate">
				<span className="text-muted-foreground">Balances </span>
				{said ? `of ${said}` : <Missing>of every account</Missing>}
			</p>
			{said && accounts.length > 0 && matched.length === 0 && (
				<p className="text-muted-foreground">
					No account called “{said}”, so every account is shown.
				</p>
			)}
			<ul className="-mx-4 flex flex-col" aria-label="Accounts">
				{accounts.length === 0 && (
					<li className="px-4 text-muted-foreground">
						{read.loading || !read.data ? 'Reading your bank…' : 'No accounts.'}
					</li>
				)}
				{(banks.length > 0 ? banks : [null]).map((bank) => (
					<BankRows
						key={bank?.connectionId ?? 'all'}
						bank={bank}
						accounts={shown.filter(
							(account) => !bank || account.connectionId === bank.connectionId,
						)}
						matched={matched}
					/>
				))}
				{folded.length > 0 && (
					<li>
						<button
							type="button"
							className="flex h-10 w-full items-center px-4 text-left text-muted-foreground hover:bg-muted"
							onClick={() => setUnfolded(true)}
						>
							{folded.length === 1 ? '1 more account' : `${folded.length} more accounts`}
						</button>
					</li>
				)}
			</ul>
			{accounts.length > 1 && (
				<p className="text-muted-foreground" aria-label="In all">
					{sumsOf(accounts).join(' · ')}
				</p>
			)}
		</WidgetFrame>
	);
}

// A bank's accounts, under its name where several banks are connected.
function BankRows({
	bank,
	accounts,
	matched,
}: {
	bank: Source | null;
	accounts: BankAccount[];
	matched: BankAccount[];
}) {
	if (accounts.length === 0) {
		return null;
	}
	return (
		<>
			{bank && (
				<li className="flex h-8 items-center px-4 text-xs text-muted-foreground">
					{bank.name ?? bank.account}
				</li>
			)}
			{accounts.map((account) => (
				<li
					key={`${account.connectionId} ${account.id}`}
					className={`flex h-10 min-w-0 items-center gap-3 px-4 ${matched.includes(account) ? 'font-medium' : ''}`}
				>
					<span className="min-w-0 flex-1 truncate">{account.name}</span>
					<span className="hidden min-w-0 flex-1 truncate font-normal text-muted-foreground md:inline">
						{detailOf(account)}
					</span>
					<span className="shrink-0 tabular-nums">
						{account.balance === null ? (
							<Missing>—</Missing>
						) : (
							<>
								{formatMoney(account.balance, account.currency)}
								{account.owed && <span className="font-normal text-muted-foreground"> owed</span>}
							</>
						)}
					</span>
				</li>
			))}
		</>
	);
}

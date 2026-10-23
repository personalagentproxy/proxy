-- `/account` is the person's account in the web app, so no organization's address can be it. One
-- named so before gets the slug a new one would, the first of `account-2`, `account-3`, … that no
-- organization has.
UPDATE "Organization"
SET "slug" = (
	SELECT 'account-' || n
	FROM generate_series(2, 99) AS n
	WHERE NOT EXISTS (SELECT 1 FROM "Organization" WHERE "slug" = 'account-' || n)
	ORDER BY n
	LIMIT 1
)
WHERE "slug" = 'account';

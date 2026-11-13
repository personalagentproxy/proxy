-- Chat on threads: a member's chat with a persona runs no agent of its own any more, and every
-- message they post in it opens a thread, whose agent answers them there. A chat from before had a
-- main agent in its own log, which handed work to sub-agents, each a child thread started by one of
-- its calls (`parentCallId`) and briefed in the agent's words. Each such chat is reshaped once, here,
-- so that it reads as the new code writes a chat: a new, empty chat takes its place, the old
-- conversation becomes one of its threads, "Earlier conversation", and each sub-agent another, under
-- its title, opened by what the member said that led to it. Nothing of a thread's tool traffic is
-- kept but a sub-agent's progress notes, as what it said; each thread's model memory is cleared, so
-- a reply starts from what the member sees; and no thread is left at work. A chat with nothing in
-- it, or with the new threads alone, is left as it is. Alerts keep their threads; pins are left to
-- the migration that drops them.

-- The chats to reshape: each member's chat with something of the old shape in it, an entry in its
-- own log or a sub-agent, with the ids of the chat that takes its place and of the old
-- conversation's task.
CREATE TEMP TABLE "ReshapedChat" AS
SELECT c."id" AS "oldId", gen_random_uuid()::text AS "newId", gen_random_uuid()::text AS "taskId"
FROM "AgentThread" AS c
WHERE c."parentThreadId" IS NULL
	AND (
		EXISTS (SELECT 1 FROM "AgentEntry" AS e WHERE e."threadId" = c."id")
		OR EXISTS (
			SELECT 1 FROM "AgentThread" AS s
			WHERE s."parentThreadId" = c."id" AND s."parentCallId" IS NOT NULL
		)
	);

-- The threads they become: each old conversation, and each of its sub-agents, with the
-- conversation it was started from.
CREATE TEMP TABLE "ReshapedThread" AS
SELECT c."oldId" AS "id", c."oldId" AS "conversationId", true AS "conversation"
FROM "ReshapedChat" AS c
UNION ALL
SELECT s."id", s."parentThreadId", false
FROM "AgentThread" AS s
JOIN "ReshapedChat" AS c ON s."parentThreadId" = c."oldId"
WHERE s."parentCallId" IS NOT NULL;

-- The new chat, the member's with the persona as the old one was, from when that was begun. It
-- takes over what is the chat's rather than the conversation's: what the member typed and hasn't
-- sent, the files in its input, and how far they have read, which the entries' `seq` keeps across
-- every thread of the chat. A member has one chat per persona, the root the old conversation stops
-- being below.
INSERT INTO "AgentThread" ("id", "orgId", "agentId", "personaId", "userId", "draft", "readSeq", "createdAt", "updatedAt")
SELECT c."newId", t."orgId", t."agentId", t."personaId", t."userId", t."draft", t."readSeq", t."createdAt", now() AT TIME ZONE 'UTC'
FROM "ReshapedChat" AS c
JOIN "AgentThread" AS t ON t."id" = c."oldId";

UPDATE "AgentEntryAttachment" AS a
SET "threadId" = c."newId"
FROM "ReshapedChat" AS c
WHERE a."threadId" = c."oldId" AND a."entryId" IS NULL;

-- Threads the new code opened in the chat already go with it.
UPDATE "AgentThread" AS t
SET "parentThreadId" = c."newId", "updatedAt" = now() AT TIME ZONE 'UTC'
FROM "ReshapedChat" AS c
WHERE t."parentThreadId" = c."oldId" AND t."parentCallId" IS NULL;

-- The old conversation becomes a thread of the new chat, with a task of its own, as every thread
-- has: finished, as the conversation's last entry was written, since nothing goes on in it.
INSERT INTO "AgentTask" ("id", "orgId", "agentId", "ownerUserId", "personaId", "title", "goal", "via", "finishedAt", "lastActiveAt", "lastStartedAt", "createdAt")
SELECT c."taskId", t."orgId", t."agentId", t."userId", t."personaId", 'Earlier conversation', 'Earlier conversation', 'harness', last."at", last."at", t."createdAt", t."createdAt"
FROM "ReshapedChat" AS c
JOIN "AgentThread" AS t ON t."id" = c."oldId"
CROSS JOIN LATERAL (
	SELECT COALESCE(MAX(e."createdAt"), t."createdAt") AS "at"
	FROM "AgentEntry" AS e
	WHERE e."threadId" = t."id"
) AS last;

UPDATE "AgentThread" AS t
SET "parentThreadId" = c."newId",
	"title" = 'Earlier conversation',
	"taskId" = c."taskId",
	"draft" = NULL,
	"readSeq" = 0,
	"updatedAt" = now() AT TIME ZONE 'UTC'
FROM "ReshapedChat" AS c
WHERE t."id" = c."oldId";

-- Each sub-agent becomes a thread of the new chat, keeping its title and its task: no call
-- started it now.
UPDATE "AgentThread" AS t
SET "parentThreadId" = c."newId", "parentCallId" = NULL, "updatedAt" = now() AT TIME ZONE 'UTC'
FROM "ReshapedThread" AS r
JOIN "ReshapedChat" AS c ON c."oldId" = r."conversationId"
WHERE t."id" = r."id" AND NOT r."conversation";

-- What the main agent said to each sub-agent, its brief, the sub-agent's first entry, and every
-- message it sent on, the sub-agent's person entries the member didn't write in its chat
-- themselves (`direct`), each with what led to it: the last thing that came into the old
-- conversation before it, what the member said or an event, an alert or another sub-agent's
-- report. What was still pending there the agent hadn't read, so led to nothing; what it had read
-- holds its place in the log, which `seq` orders across every thread. `nth` counts the messages
-- one thing of the member's led to in the sub-agent, in order.
CREATE TEMP TABLE "Forwarded" AS
SELECT f.*, row_number() OVER (PARTITION BY f."threadId", f."saidId" ORDER BY f."seq") AS "nth"
FROM (
	SELECT e."id", e."threadId", e."seq",
		e."seq" = first."seq" AS "brief",
		said."id" AS "saidId", said."kind" AS "saidKind", said."text" AS "saidText"
	FROM "ReshapedThread" AS r
	JOIN "AgentEntry" AS e ON e."threadId" = r."id"
	CROSS JOIN LATERAL (
		SELECT MIN(other."seq") AS "seq" FROM "AgentEntry" AS other WHERE other."threadId" = r."id"
	) AS first
	LEFT JOIN LATERAL (
		SELECT c."id", c."kind", c."text"
		FROM "AgentEntry" AS c
		WHERE c."threadId" = r."conversationId"
			AND c."kind" IN ('person', 'event')
			AND NOT c."pending"
			AND c."seq" < e."seq"
		ORDER BY c."seq" DESC
		LIMIT 1
	) AS said ON true
	WHERE NOT r."conversation" AND e."kind" = 'person' AND NOT e."direct"
) AS f;

-- A thread is opened and taken up by the member's own words, so what the member said takes the
-- place of what the agent made of it, the first time it led to something in the thread, with the
-- files they attached to it.
UPDATE "AgentEntry" AS e
SET "text" = f."saidText"
FROM "Forwarded" AS f
WHERE e."id" = f."id" AND f."saidKind" = 'person' AND f."nth" = 1;

INSERT INTO "AgentEntryAttachment" ("id", "entryId", "threadId", "position", "connectionId", "fileId", "version", "name", "type", "size", "text", "cut", "createdAt")
SELECT gen_random_uuid()::text, f."id", f."threadId", a."position", a."connectionId", a."fileId", a."version", a."name", a."type", a."size", a."text", a."cut", a."createdAt"
FROM "Forwarded" AS f
JOIN "AgentEntryAttachment" AS a ON a."entryId" = f."saidId"
WHERE f."saidKind" = 'person' AND f."nth" = 1;

-- A sub-agent the member's words didn't lead to, which an alert or a report started, is a thread
-- something else opened: its brief stays as the agent wrote it, as an event, which is how the new
-- code opens one.
UPDATE "AgentEntry" AS e
SET "kind" = 'event'
FROM "Forwarded" AS f
WHERE e."id" = f."id" AND f."brief" AND f."saidKind" IS DISTINCT FROM 'person';

-- A message the agent sent on that the member's words didn't lead to, or that their words led to
-- again, is the agent's relaying, which a thread has none of.
DELETE FROM "AgentEntry" AS e
USING "Forwarded" AS f
WHERE e."id" = f."id"
	AND NOT f."brief"
	AND (f."saidKind" IS DISTINCT FROM 'person' OR f."nth" > 1);

-- A sub-agent's progress notes, its send_to_parent calls, were what it said as it went: each
-- becomes part of what the answer that made it says, after its own words, in order, as the tool
-- would take it, a call whose arguments are no message giving none.
UPDATE "AgentEntry" AS e
SET "text" = concat_ws(E'\n\n', NULLIF(e."text", ''), notes."text")
FROM (
	SELECT e."id", string_agg(note."text", E'\n\n' ORDER BY call."n") AS "text"
	FROM "ReshapedThread" AS r
	JOIN "AgentEntry" AS e ON e."threadId" = r."id"
	CROSS JOIN LATERAL jsonb_array_elements(e."toolCalls"::jsonb) WITH ORDINALITY AS call("value", "n")
	CROSS JOIN LATERAL (
		SELECT CASE
			WHEN pg_input_is_valid(call."value"->>'arguments', 'jsonb') THEN (call."value"->>'arguments')::jsonb
		END AS "args"
	) AS parsed
	CROSS JOIN LATERAL (
		SELECT CASE
			WHEN jsonb_typeof(parsed."args") = 'object' AND jsonb_typeof(parsed."args"->'text') = 'string'
				THEN regexp_replace(parsed."args"->>'text', '^\s+|\s+$', '', 'g')
		END AS "text"
	) AS note
	WHERE e."kind" = 'assistant'
		AND e."toolCalls" IS NOT NULL
		AND call."value"->>'name' = 'send_to_parent'
		AND note."text" <> ''
	GROUP BY e."id"
) AS notes
WHERE e."id" = notes."id";

-- The rest of the tool traffic goes: what calls answered; in the old conversation, the sub-agents'
-- reports, events answering the call that started one, and the notes of what the member wrote to a
-- sub-agent, which that sub-agent's thread has as theirs. An alert's event, which answers no call,
-- stays, as an alert of a thread lands one. The calls go from every answer, and an answer left with
-- no words with them; the summaries stay, for the model to read in place of what they cover.
DELETE FROM "AgentEntry" AS e
USING "ReshapedThread" AS r
WHERE e."threadId" = r."id"
	AND (
		e."kind" = 'tool_result'
		OR (r."conversation" AND e."kind" = 'note')
		OR (r."conversation" AND e."kind" = 'event' AND e."callId" IS NOT NULL)
	);

UPDATE "AgentEntry" AS e
SET "toolCalls" = NULL
FROM "ReshapedThread" AS r
WHERE e."threadId" = r."id" AND e."kind" = 'assistant' AND e."toolCalls" IS NOT NULL;

DELETE FROM "AgentEntry" AS e
USING "ReshapedThread" AS r
WHERE e."threadId" = r."id" AND e."kind" = 'assistant' AND e."text" = '';

-- The files of the entries gone go with them: the relations are Prisma's (schema.prisma), so no
-- foreign key deletes them.
DELETE FROM "AgentEntryAttachment" AS a
USING "ReshapedThread" AS r
WHERE a."threadId" = r."id"
	AND a."entryId" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "AgentEntry" AS e WHERE e."id" = a."entryId");

-- What is left is written as the new code writes it: what the member said in a thread is theirs,
-- written by no job, wherever they wrote it, and no entry answers a call.
UPDATE "AgentEntry" AS e
SET "direct" = false, "callId" = NULL, "jobId" = CASE WHEN e."kind" = 'person' THEN NULL ELSE e."jobId" END
FROM "ReshapedThread" AS r
WHERE e."threadId" = r."id" AND (e."direct" OR e."callId" IS NOT NULL OR (e."kind" = 'person' AND e."jobId" IS NOT NULL));

-- What was pending, waiting on a turn or a call that won't come now, takes its place at the end of
-- its thread, in the order it landed, as it would have once nothing held it.
CREATE TEMP TABLE "Released" AS
SELECT waiting."id", nextval(pg_get_serial_sequence('"AgentEntry"', 'seq')) AS "seq"
FROM (
	SELECT e."id"
	FROM "AgentEntry" AS e
	JOIN "ReshapedThread" AS r ON r."id" = e."threadId"
	WHERE e."pending"
	ORDER BY e."seq"
) AS waiting;

UPDATE "AgentEntry" AS e
SET "seq" = released."seq", "pending" = false
FROM "Released" AS released
WHERE e."id" = released."id";

-- No reshaped thread is left at work: each job still to run or running fails, saying why, noted as
-- a failure as a worker's is, and one a worker runs now finds it no longer its own. The jobs stay,
-- since entries name the job that wrote them; a tool job no longer names its call, which no answer
-- holds now.
CREATE TEMP TABLE "ClosedJob" AS
SELECT j."id", j."threadId"
FROM "AgentJob" AS j
JOIN "ReshapedThread" AS r ON r."id" = j."threadId"
WHERE j."status" IN ('queued', 'running');

UPDATE "AgentJob" AS j
SET "status" = 'failed',
	"error" = 'The chat moved to threads before this job ran',
	"claimedBy" = NULL,
	"leaseExpiresAt" = NULL,
	"updatedAt" = now() AT TIME ZONE 'UTC'
FROM "ClosedJob" AS c
WHERE j."id" = c."id";

INSERT INTO "AgentJobEvent" ("id", "jobId", "threadId", "kind", "error", "at")
SELECT gen_random_uuid()::text, c."id", c."threadId", 'failed', 'The chat moved to threads before this job ran', now() AT TIME ZONE 'UTC'
FROM "ClosedJob" AS c;

UPDATE "AgentJob" AS j
SET "entryId" = NULL, "callId" = NULL
FROM "ReshapedThread" AS r
WHERE j."threadId" = r."id" AND j."kind" = 'tool' AND (j."entryId" IS NOT NULL OR j."callId" IS NOT NULL);

-- And no task of theirs is left under way: each still open is finished, with every sub-task of it,
-- as finishing a task finishes them (db/task.ts). One left open keeps when it ended, 20 minutes
-- after anything was last done for it (@proxy/utils/tasks); one under way ends now.
WITH RECURSIVE "open" AS (
	SELECT task."id"
	FROM "AgentTask" AS task
	JOIN "AgentThread" AS t ON t."taskId" = task."id"
	JOIN "ReshapedThread" AS r ON r."id" = t."id"
	WHERE task."finishedAt" IS NULL
	UNION
	SELECT sub."id"
	FROM "AgentTask" AS sub
	JOIN "open" AS o ON sub."parentId" = o."id"
	WHERE sub."finishedAt" IS NULL
)
UPDATE "AgentTask" AS task
SET "finishedAt" = LEAST(now() AT TIME ZONE 'UTC', task."lastActiveAt" + interval '20 minutes'),
	"lastActiveAt" = CASE
		WHEN task."lastActiveAt" + interval '20 minutes' > now() AT TIME ZONE 'UTC' THEN now() AT TIME ZONE 'UTC'
		ELSE task."lastActiveAt"
	END
FROM "open" AS o
WHERE task."id" = o."id";

-- Each reshaped thread starts on a fresh model memory, which reads the thread as the member sees
-- it rather than the relaying it has lost: its harness's session is forgotten, and the Claude Agent
-- SDK's transcript of it, kept under the session's id, deleted.
DELETE FROM "AgentHarnessTranscript" AS h
USING "AgentThread" AS t
JOIN "ReshapedThread" AS r ON r."id" = t."id"
CROSS JOIN LATERAL (
	SELECT CASE
		WHEN pg_input_is_valid(t."harnessSession", 'jsonb') THEN t."harnessSession"::jsonb
	END AS "value"
) AS kept
WHERE jsonb_typeof(kept."value") = 'object' AND h."sessionId" = kept."value"->>'id';

UPDATE "AgentThread" AS t
SET "harness" = NULL, "harnessSession" = NULL
FROM "ReshapedThread" AS r
WHERE t."id" = r."id";

DROP TABLE "ClosedJob";
DROP TABLE "Released";
DROP TABLE "Forwarded";
DROP TABLE "ReshapedThread";
DROP TABLE "ReshapedChat";

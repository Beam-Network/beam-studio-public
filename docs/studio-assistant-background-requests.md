# Background assistant conversations

Home submits turns to `POST /studio/assistant/requests`. The server commits the
conversation, user message, request key, context and execution scope before
returning HTTP 202 with `{ conversationId, request }`. Messages for subsequent
turns come from the stored conversation, not a browser-provided transcript.

Requests move through `queued`, `running`, `succeeded`, `failed` or `cancelled`.
The API worker executes up to four requests concurrently. A database constraint
allows only one queued/running request per conversation; other conversations
remain independent. Reusing a submission key returns the existing request and
never appends another user message.

- `GET /studio/assistant/requests/:id` returns public request state and its result.
- `POST /studio/assistant/requests/:id/cancel` stops a queued/running request.
- `POST /studio/assistant/requests/:id/retry` retries the latest failed/cancelled
  turn without adding another user message.
- Conversation list/detail responses include the latest request and `unread`.
- `POST /studio/assistant/conversations/:id/read` acknowledges an exact completed
  `requestId`, so reading one answer cannot mark a newer answer as read.

The original `/studio/assistant/chat` endpoint remains a compatibility observer
for contextual clients. Disconnecting that HTTP response does not cancel the job.
Home polls active conversation state and history; it does not own a generation's
lifetime. Closing the tab, changing chats or archiving a chat leaves work running.
Only the explicit cancellation endpoint stops it.

The startup schema creates `assistant.requests` and adds
`assistant.conversations.read_request_id`. Start/restart the API after updating
so its normal PostgreSQL schema initialization runs before accepting requests.
Queued requests survive an API restart. A running request whose lease expires
becomes an explicit interrupted failure that can be retried; it is not replayed
automatically, because the provider may already have billed the previous attempt.
Each execution has a unique lease token that fences late results after cancellation
or retry. The assistant message and terminal success state commit together.

Jobs retain an encrypted reference to the browser session, never a raw bearer
or refresh token. The worker revalidates user, organization and project access
before execution and uses the existing OAuth refresh service. The encrypted
reference is cleared on completion/cancellation; retry uses the caller's current
session. Multiple API instances must have access to the same encrypted OAuth
session store and vault secret, as required by the existing session architecture.

`assistant-requests.test.ts` exercises the real startup SQL and repository using
an isolated temporary schema on a local PostgreSQL database. Set
`ASSISTANT_TEST_DATABASE_URL` to the local test database URL to run it; remote
hosts are rejected, and the temporary schema is removed after each test.

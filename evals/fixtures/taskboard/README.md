# Taskboard API

A small task-tracking HTTP API. It is the fixture codebase for the oca eval suite.
It is never run; it only needs to be realistic and stable.

## Authentication

Clients log in with `POST /auth/login` and receive a short-lived access token and a refresh token.
Access tokens are HMAC-SHA256 signed, JWT-style tokens and must be sent as `Authorization: Bearer <token>`.

## Task workflow

Every task moves through a fixed set of states:

```
todo ──► in_progress ──► done ──► archived
  │            │            │
  │            └──► todo    └──► in_progress (reopen)
  └──► archived
```

Archived tasks are final and cannot change state again. Marking a task **done** sends a `task.completed` webhook.

## Webhooks

Webhook deliveries are signed with the `X-Taskboard-Signature` header (hex HMAC-SHA256 of the body) and retried with exponential backoff.

## Rate limiting

Each client IP gets a token bucket. When it is empty, the API answers `429 Too Many Requests` with a `Retry-After` header.

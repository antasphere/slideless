# ADR 001 — Version pins for the platform chassis

Status: accepted (2026-07-03)

## Decision

Pin the following, verified against real installs and the integration suite:

- **Node 22** (image `node:22-alpine`), pnpm 10, turborepo 2.
- **better-auth 1.6.15 exact + @better-auth/oauth-provider 1.6.15 exact**,
  with pnpm overrides scoped to those parents forcing `@better-auth/core`
  1.6.15 (oauth-provider@1.6.15 peers `@better-fetch/fetch@1.1.21` while core
  1.6.16+ wants 1.2.2 — bump all three together or not at all). The
  standalone `@better-auth/cli` is pinned separately at 1.4.21 (own version
  line; used only for schema generation + the CI drift guard).
- **hono ^4.9 + @hono/node-server ^1.14 + @hono/zod-openapi ^1.4**, zod ^4.1
  workspace-wide (`@hono/zod-openapi` ≥1.4 peers zod v4).
- **drizzle-orm ^0.45 + drizzle-kit ^0.31**, pg ^8.16 (node-postgres — never
  a serverless driver in this template).
- **pg-boss ^10** (v10 semantics: `start()` mandatory before `send()`,
  `work()` handlers receive arrays, `stop()` waits by default).
- pino ^9 (+pino-pretty dev), rate-limiter-flexible ^7, ioredis ^5,
  nodemailer ^9, resend ^6, ulid ^3, tsup ^8, vitest ^3, testcontainers ^11.
- **DB container: `pgvector/pgvector:pg17`** (Postgres 17 + pgvector
  available; see ADR 004 for who runs CREATE EXTENSION).

## Why

A predecessor production template proved the Better Auth 1.6.15 trio in production; the
oauth-provider peer conflict makes uncoordinated bumps fail at install time,
so the pin is exact and the drift guard fails CI when an upgrade changes the
expected auth schema. Everything else pins to the majors the risk review
verified for zod-v4 and ESM compatibility.

## Revisit when

Better Auth ships a coherent >1.6.15 trio (drift + integration suites gate
the bump), or the MCP SDK v2 (Standard Schema, native Hono adapter) leaves
beta (see ADR 002, M6).

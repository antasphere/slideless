# ADR 004 — pgvector: available in the image, created by products

Status: accepted (2026-07-03)

## Decision

The compose stack ships `pgvector/pgvector:pg17`, so the `vector` extension
is **available** on every self-hosted instance. The template itself does NOT
run `CREATE EXTENSION vector` — no template table uses embeddings, and on
Profile B managed Postgres a restricted role may lack the privilege, which
would fail boot migrations for a feature the deployment never uses.

Products that need embeddings own the activation: their first migration runs
`CREATE EXTENSION IF NOT EXISTS vector;` and their Profile B docs must state
that the managed database needs the extension enabled (Cloud SQL / AlloyDB /
Neon all offer it).

## Why

Keeps the template's migrations privilege-minimal and profile-agnostic while
honoring the brief's "pgvector must be available" requirement where the
template controls the database (Profile A). The integration suite asserts
availability (`pg_available_extensions`) against the shipped image.

# Agent Note: SSH settings migrate id-less connection records at schema resolution

Status: implemented

English | [中文](2026-08-14-ssh-settings-id-migration.zh.md)

## Problem

The persisted `ssh-connections` namespace may contain connection rows without `id` and workspace defaults that name labels. A required `id` field rejects that document while the namespace registers, so the runtime migration cannot run and the SSH settings section remains unavailable.

## Decision

The SSH settings schema accepts an id-less row only through a per-row compatibility transform that emits a UUID and keeps the canonical `SshConnection` output. The transform uses browser-and-Node Web-standard globals because the serialized schema is rehydrated in the settings client. The runtime inspects the raw user layer after registration and replaces an id-less section with the resolved rows and id-keyed workspace defaults, preserving the generated ids on disk.

## Alternatives considered

**Make `id` permanently optional.** Rejected because consumers and persisted canonical data require stable ids; a permanently optional schema would allow unresolved rows to escape the migration path.

**Migrate only after registering a strict schema.** Rejected because registration validates the stored section before the runtime can obtain a scope, so the migration remains unreachable for id-less documents.

**Use a Node-only imported migration callback in the serialized schema.** Rejected because browser rehydration executes the callback from its serialized source and cannot resolve a Node module binding.

## Consequences

Existing id-less SSH settings load immediately with canonical ids, and the first runtime write makes those ids durable. Label-keyed workspace defaults are rewritten to ids at the same time. New writes continue to validate the required canonical id field, while the settings client can validate the same compatibility schema after rehydration.

## Verification

`packages/ssh/ssh/tests/settings-migration.spec.ts` covers Host resolution, serialized-schema rehydration, namespace registration, id persistence, and default remapping. The focused SSH model and migration tests, SSH and UI-SSH type checks, the UI-SSH regression test, and a cold Web boot all pass.

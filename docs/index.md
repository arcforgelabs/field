---
title: "Field docs"
summary: "Quote building and invoicing for trade operators."
---

# Field docs

Field builds quotes and invoices from an operator's own price catalogue.
It sends them by email, and keeps every document exactly as it was sent.
A typed API, CLI and MCP server let other systems build and revise quotes.

## Start here

- [Self-host Field](SELF_HOSTING.md) on your own server or container host.
- [Run Field on Replit](REPLIT.md).
- [Set up Clerk sign-in](CLERK_SIGN_IN.md).

## How Field works

- [Pricing engine](PRICING_ENGINE.md) and the [Surveyor](concepts/surveyor.md).
- [Integrations](INTEGRATIONS.md): [Xero](XERO.md), [Gmail sending](GMAIL_SENDING.md) and [remote MCP](REMOTE_MCP.md).

## Releases

[Release notes](releases/index.md) list what changed in each version.

The source of these pages is the `docs/` folder of
[arcforgelabs/field](https://github.com/arcforgelabs/field).

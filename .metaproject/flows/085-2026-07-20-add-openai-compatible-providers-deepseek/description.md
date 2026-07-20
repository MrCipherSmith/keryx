# Add OpenAI-compatible providers (DeepSeek, Z.AI GLM, Cerebras, Groq, Moonshot)

Status: formalized
Source: user request (screenshots of opencode's grouped picker + "add DeepSeek, GLM z.ai coding plan, and others via API key")

## Problem

The picker only offered OpenRouter (+ ollama/anthropic/fake). Many OpenAI-Chat-
Completions-compatible gateways are reachable with just a base URL + Bearer key —
the user wants DeepSeek, Z.AI GLM (they have a flat-rate Coding Plan + API), and
others addable via an API key. Our OpenRouter path was already an OpenAI-compat
adapter, so this generalizes to a registry.

## Expected Outcome

- A provider registry (base URL, env key, path overrides, curated fallback models).
- detect + make-provider + picker all driven by the registry; keys prompted +
  persisted per provider (0600), loaded into env at startup.
- Live `/models` per provider (filterable), curated fallback on failure.
- Z.AI's versioned `…/paas/v4` endpoints handled via a chat/models path override
  (the adapter previously hard-coded `/v1/chat/completions`).

## Out of Scope

- Migrating the catalog to models.dev (opencode-style groups/Free badges/Recent) —
  a separate, larger follow-up.
- Anthropic-compatible coding endpoints (Z.AI/Moonshot `/anthropic`); only the
  OpenAI-compat endpoints are wired here.

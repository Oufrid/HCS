# Injection corpus

Measures the prompt-injection guard (`src/guard.ts`). One sample per line; lines starting with `#` and blank
lines are ignored.

- `attacks.txt`: text that tries to instruct a model that reads it. Written for this corpus, paraphrasing
  publicly documented attack patterns: direct "ignore previous instructions" prompts (Perez & Ribeiro, 2022),
  indirect injections hidden in web pages, READMEs and code comments (Greshake et al., 2023), role-play
  jailbreaks (DAN, "developer mode", "grandma"), chat-template smuggling, prompt-leak requests, and data
  exfiltration through Markdown images or webhooks. None are copied verbatim from a single source.
- `benign.txt`: ordinary technical text that shares vocabulary with attacks (ignore, override, system prompt,
  instructions, tokens, curl, user, assistant...). A guard that flags these is too eager.

The guard tests (`test/guard.test.ts`) compute precision and recall on this corpus at two thresholds: *high*
(the claim is tagged `suspect` and not rendered) and *any* (also low-risk findings, reported for review).
Patterns were tuned with this corpus in view, so the numbers are in-sample and optimistic; the README also
gives the numbers measured before tuning.

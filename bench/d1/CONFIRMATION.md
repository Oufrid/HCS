# D1 confirmation run (pre-registered 2026-10-22, before any model call on these repositories)

The compact render profile (SPEC 6.2) was designed after looking at the five D1 repositories. This run checks whether
its result holds on repositories that played no part in that design. Everything below is fixed before running.

**Repositories** (pinned in `repos.json`, `"set": "confirmation"`): expressjs/express (JavaScript, `lib`, `index.js`,
Readme), psf/requests (Python, `src`, README), sirupsen/logrus (Go, top-level non-test `.go` files, README). Chosen
for language and size (22k to 56k source tokens) before any run, as well-known public libraries.

**Pipeline**, unchanged from the D1 v2 run: compile, naive summary and independent probes with gemini-3.8-flash
(`compile`, `summarize`, `probes` steps; 30 probes per repository), budget 2,000 tokens, same decoder instructions.

**Answering family 1**: gemini-3.8-flash answers, groq:openai/gpt-oss-20b judges. Conditions: `hcs-compact`, `hcs`,
`summary`, `none`, `readme`, `hcs-compact+expand`, `summary+open`.

**Answering family 2**: groq:openai/gpt-oss-20b answers, gemini-3.8-flash judges. Conditions: `hcs-compact`,
`summary` (free tier: reported when complete, possibly on later days).

**Primary endpoint**: pooled over the independent probes of the three repositories, the paired difference
`hcs-compact` minus `summary` for family 1, with a 95% paired bootstrap CI (as `bench/d1/analysis-v2.txt`). The result
**confirms** the D1 finding if the interval is entirely above zero, and does not confirm it otherwise. Secondary:
the same for family 2; `hcs-compact` minus `none`, minus `readme`, minus `hcs`; `hcs-compact+expand` minus
`summary+open`. Every number is reported, whichever way it goes.

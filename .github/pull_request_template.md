## What and why

<!-- What this changes, and the problem it solves. Link the issue or RFC. -->

## Checks

- [ ] `npm test` passes
- [ ] `node dist/src/cli.js check project.hcs --strict` passes (claims re-sealed only after re-reading them)
- [ ] New behavior has a test; format, hashing or verification changes have a conformance case that the Python
      implementation passes too (`npm run conformance`, `python3 -m unittest discover -s python/tests`)
- [ ] Spec changes follow an accepted RFC (`rfcs/`) and add a version note to `SPEC.md`
- [ ] Docs updated (README, SPEC, limitations in PRIOR_ART) where behavior changed
- [ ] No API keys, no illustrative numbers presented as results; benchmark numbers come with their raw results file

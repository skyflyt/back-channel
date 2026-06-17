# Contributing to Back Channel

Project is in very early phase (pre-POC). Feedback on the vision and architecture is more valuable than code right now.

## What helps most

1. **Architecture review.** Read the README and SECURITY.md. Open a discussion if any of the model doesn't make sense, has a gap, or could be simpler.
2. **Threat modeling.** Think adversarially. What's the worst a malicious visitor agent could do under each scope? Open an issue.
3. **Use cases.** If you have a personal AI assistant setup and would use this, describe the workflow you'd want.
4. **A2A protocol insights.** If you've worked with the A2A protocol, identify gotchas or features we should design around.

## What's premature right now

- Code PRs against the (non-existent) implementation
- Plugin / scope contributions before the core API exists
- UI mockups before the architecture is locked

## The hard rules

1. **Never commit secrets.** No API keys, tokens, passwords, credentials. Pre-commit hook (gitleaks) will be added soon; until then, please be careful.
2. **Privacy by default.** Any feature proposal must explain what happens to user data, what's exposed, what's redacted.
3. **MIT license.** All contributions are under MIT.
4. **Be kind.** This is a project about extending trust between agents and between humans. Reflect that in how you participate.

## Code style (when we get there)

- TypeScript for broker + UI
- ESLint + Prettier configs to follow
- All public APIs need TSDoc
- Tests required for security-sensitive paths

## How to propose a change

1. Open an issue describing the proposal (not a PR first)
2. Discuss the design
3. Once aligned, submit a PR referencing the issue
4. CI must pass (lint, type-check, tests)
5. Maintainer review

## License

By contributing you agree your contribution is licensed under the MIT license.

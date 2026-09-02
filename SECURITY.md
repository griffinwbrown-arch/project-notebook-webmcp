# Security policy

## Supported version

Security fixes target the latest code on `main`. Release notes identify older versions when a fix also applies there.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not put exploit details, private data, or credentials in a public issue.

Include the affected version, entry point, prerequisites, impact, and the smallest safe reproduction you can provide. Remove tokens, personal notebook content, and local file paths from logs or screenshots.

If private reporting is unavailable, contact the repository owner through the GitHub profile without publishing technical details. The owner can open a private advisory for the full report.

## Product boundaries

Project: Notebook stores demo data in the visitor's browser. Page-scoped WebMCP tools validate typed inputs, revisions, visible targets, and app-owned limits before changing notebook state.

Do not include secrets in issues, pull requests, fixtures, notebooks, screenshots, or `.env` files. Local Sites project IDs, hackathon account state, and deployment credentials do not belong in this repository.

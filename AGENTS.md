# Graphdozer Counseling — Sandbox

This repository contains a fictional solo practice at `https://graphdozer.com`. Its two approved records live in `practice-records/practices/graphdozer-sandbox/` inside this repository.

## Update the practice

1. Edit `website-facts.json` for identity, license, location, hours, fees, availability, or the disclaimer. Edit `insurance.json` for carriers, labels, or the couples policy. Use the supplied or otherwise verified values.
2. Run `npm run sync`. It copies both records into `src/data/*.generated.json`, generates `public/llms.txt`, checks the source, and renders the pages in a temporary directory to check their actual HTML.
3. Run `npm run build`. This repeats the sync and checks, then writes the static website to `dist/`. Review the generated changes alongside the approved records. When a commit is authorized, include both in that commit.

Use the Node version in `.node-version` and install dependencies with `npm ci` on a fresh checkout. The Pages build command is `npm run build` and its output directory is `dist`. This repository follows the workspace publishing rules in `~/code/site-ops/AGENTS.md`.

Use `src/data/practice.ts` and `src/data/availability.ts` for practice facts and status. Read carriers from the generated insurance record. Keep display hours and Schema.org hours in their respective record fields. Edit the summary template in `practice-records/sync-and-check.mjs` when its wording needs to change. The sync checks the generated summary's checksum before replacing it so a manual change cannot silently disappear during a build.

## YMYL and HIPAA safeguards

- Use only approved, verified facts. Never guess credentials, participation in insurance networks, coverage, fees, appointment availability, or treatment outcomes. Identify the sandbox and its test license wherever visitors might mistake it for a real practice.
- Keep the full crisis disclaimer, including 988 and 741741, clinician attribution, test license, and telehealth boundary visible on every page through `BaseLayout.astro`.
- Keep copy educational. Prohibit curative claims and promises of results. Show the session count and rates used in cost examples.
- Keep this sandbox free of real client data. Do not solicit, store, log, or transmit protected health information. The contact page displays availability only.
- Use zero third-party tracking scripts. Never add unapproved tracking pixels, analytics tags, or advertising beacons.

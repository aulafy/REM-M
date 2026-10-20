# Pilot with real, non-technical users

OpenCMO has been tested by its builders and by automated tests. It has **not** yet been used by real small-business owners. This kit turns the first 5 sessions into evidence you can act on. Everything stays local: no analytics, no accounts, nothing is sent anywhere.

## Who to recruit (5 people, 30 minutes each)
- A shop owner, a freelancer, a consultant, a restaurant/café owner, an association manager.
- **Not** developers. They have never used Ollama, an API key or a terminal.
- Each has a real website (or says "I don't have one" — test that path too).

## Setup before each session
1. Install and start OpenCMO on a clean data folder: `npx github:raym33/opencmo --data-dir ./pilot-N` (or `npm start` with `DATA_DIR=./pilot-N`).
2. Decide the AI route in advance and tell nobody: local model installed, or an online key you provide, or "let them choose".
3. Screen-record (with consent) or take notes. **Do not help** unless they are stuck for more than 60 seconds; note exactly where they got stuck.

## The task you give them (read aloud, nothing more)
> "You want customers to find your business online. Using this tool, get your first post ready to publish. Think aloud."

## What to measure (fill one row per person)
| Measure | How | Target |
| --- | --- | --- |
| Reached step 5 (first review) without help | yes/no | ≥ 4 of 5 |
| Time to first approved text | minutes | ≤ 15 (online AI) / ≤ 30 (local AI) |
| Step where they hesitated longest | step number | none repeated by ≥ 3 people |
| Words they did not understand | write them down | 0 repeated |
| Would they publish the text as is, edited, or not at all? | as is / edited / no | ≥ 3 "as is or edited" |
| Did they trust "nothing is published without my OK"? | 1–5 | ≥ 4 |

## Questions at the end (ask exactly these)
1. In your own words, what does this tool do?
2. What was the most confusing moment?
3. Would you use it next week? What would stop you?
4. What would you expect to pay for it per month, if anything? (Ask before showing any price.)
5. Who else do you know who would want this?

## Decision rules
- If 3+ people stall at the same step, **fix that step before anything else** — do not add features.
- If fewer than 3 would use it next week, the problem is value, not polish: rewrite the promise on the landing page and re-test with 3 new people.
- If 3+ name a price you would be happy to charge, that is your first pricing hypothesis (an optional managed/hosted offering is an idea only — see `docs/LAUNCH.md`).
- Record results in `docs/pilot-results.md` (create it; one section per person, quotes verbatim).

## Honest limits
Five sessions give direction, not statistics. They show where non-technical users stall; they do not prove demand. Treat the numbers above as thresholds to act on, not as marketing claims.

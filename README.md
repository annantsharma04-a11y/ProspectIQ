# ProspectIQ

Paste a public LinkedIn profile URL. The app resolves who the person is, researches
them and their company against real public sources, ranks the signals it finds,
picks the strongest legitimate outreach angle, drafts a message, fact-checks every
claim in that message against the evidence, and **stops for human review**.

Nothing is ever sent. There is no stub mode, no seeded data, and no hardcoded
prospects — every run performs real API calls, and a run that finds nothing says so.

## Stack

- **Next.js 16** (App Router, TypeScript, Tailwind 4)
- **Bright Data** — LinkedIn profile data (the only LinkedIn provider)
- **Tavily** (primary) + **Brave** (optional) — public web and news search
- **Firecrawl** — page fetching for non-LinkedIn sources
- **Google Gemini** via the **Interactions API** — ONE schema-constrained call per
  prospect, with automatic fallback to a second model on quota exhaustion
- **Supabase** (Postgres + Realtime) — persistence and the live run feed
- **Inngest** (optional) — durable execution

## Quick start

```bash
npm install
cp .env.local.example .env.local    # fill in the keys
# apply supabase/migrations/*.sql in order (SQL editor, or psql)
npm run dev
```

Then open http://localhost:3000 and paste a LinkedIn profile URL.

Required to run at all: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`GEMINI_API_KEY`, and at least one of `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY`.
`BRIGHTDATA_API_TOKEN` is required for direct profile retrieval; without it the
app still runs, using public-web research only, and reports that in the UI.

## The pipeline

Fourteen stages, each recorded in `run_stages` with its status, duration, summary and
raw output. The middle panel shows them executing live.

The order encodes the product's core principle: **establish who this is, decide whether
they are worth contacting, and only then look for something to say.**

| # | Stage | What it actually does |
|---|-------|----------------------|
| 1 | `validate_input` | Normalizes and validates the LinkedIn URL. Invalid URLs are rejected by `POST /api/runs` with a 400 before a run row is created. |
| 2 | `identify_prospect` | Retrieves the profile via Bright Data and discovers every person this input could plausibly represent. Lightweight — it does not prove identity. |
| 3 | `resolve_candidate` | One plausible candidate resolves automatically; several pause the run for a human to choose. The system never guesses which person was meant. |
| 4 | `verify_identity` | Tests the selected candidate against independent public sources. A missing role or company triggers one anchored recovery attempt. Only VERIFIED proceeds. |
| 5 | `research_prospect` | Person-level searches, anchored to the verified identity. |
| 6 | `research_company` | Company news, funding, hiring, product and strategy. Runs employer discovery when the profile lacked a company. |
| 7 | `qualify_prospect` | Is this person a meaningful target — function, seniority, influence over the relevant workflows? |
| 8 | `qualify_company` | Does the *evidence* show workflows the product serves? Industry is context, never proof. Makes the go/no-go call. |
| 9 | `collect_signals` | Consolidates the deduplicated evidence set and grades each source. |
| 10 | `evaluate_signals` | **The single analysis call.** Proposes signals with citations, picks a hook, drafts the message. Citations are then verified mechanically. |
| 11 | `select_hook` | Deterministic gate: rejects disputed, sub-threshold, or unevidenced-use-case hooks. Never substitutes a different hook silently. |
| 12 | `generate_message` | Persists the draft — only when a hook survived. Personalisation and opener-quality checks, one regeneration. |
| 13 | `validate_claims` | Claim-by-claim adjudication that can only tighten the verdict. |
| 14 | `ready_for_review` | Sets final status and confidence. Nothing is sent. |

## Identity before targeting

A name match is not an identity. Several people share a name, and the profile provider
is one evidence source rather than the truth, so identity is settled before anything
downstream runs:

- **Discovery** enumerates candidates; **selection** picks one (automatically when only
  one is plausible, otherwise by asking); **verification** tests that one candidate
  against independent sources.
- A material conflict on company or role is `AMBIGUOUS`, and the run stops. Missing
  material fields are `PARTIAL`, never a guess.
- When the rest of an identity agrees but a critical field is missing, one **anchored
  recovery** search runs. A value is accepted only when a retrieved source states it for
  *this* person; a same-name different person is treated as a conflict, never a match.
- A user selecting a candidate is a preference, not proof — verification runs identically
  either way, and a chosen candidate that still conflicts stays at manual review.
- Once VERIFIED, downstream stages run *on* that identity. They cannot revise it.

## Qualification before outreach

An interesting news event is not evidence of fit. Prospect fit and company fit are judged
separately, combined as the **weaker of the two** (never an average), and only `QUALIFIED`
proceeds. Company fit must rest on an **observed** workflow: capability matches are labelled
`OBSERVED` / `INFERRED` / `UNKNOWN`, and inference alone cannot qualify a company.

## Model usage and quota resilience

**One Gemini call per prospect.** Identity mapping, dedup, scoring, hook gating,
quote verification and claim checks are all ordinary code — a model is used only
where judgment is genuinely required.

`GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL` are configuration; no model id is
hardcoded in application logic. Provider errors are classified, not lumped
together:

| Class | Behaviour |
|---|---|
| `provider_error` (5xx, network, timeout) | bounded exponential retry, same model |
| `rate_limited` (short-window throttle) | bounded retry, same model |
| `quota_exhausted` (per-day / free-tier cap) | no retry — switch to the fallback model |
| `model_unavailable` | no retry — switch to the fallback model |
| `authentication_error`, `invalid_request` | fail fast; a fallback would fail identically |

If every model is exhausted, the run is parked as **`ai_analysis_pending`** with
the profile and all sources already saved. `POST /api/runs/<id>/retry-analysis`
resumes from the analysis stage and reuses that stored research, so recovering
from a quota outage costs one model call rather than a fresh round of provider
spend. The UI shows a "Retry AI analysis" button for exactly this state.

## How it avoids making things up

- **Signals must be quotable.** Every extracted signal cites a retrieved URL and a
  verbatim quote; `verifyHooks` drops any signal whose URL was never
  fetched or whose quote is not actually in that source.
- **Claim-level fact check.** Each assertion in the draft is adjudicated against the
  evidence. An UNSUPPORTED claim that survives into the final text escalates the run
  to `flagged` automatically, regardless of what the model reported.
- **A ranking floor.** No signal below the quality threshold, and no disputed signal,
  can become a hook — enforced in code after the model chooses.
- **Insufficient evidence is a valid outcome.** When nothing qualifies, the app says
  *"Insufficient verified public information for high-confidence personalization"*,
  writes a conservative message that references no research, and holds it for review.
- **Failures are failures.** A dead search provider or a failed LLM call marks the
  stage failed and preserves the run for retry. No stage ever invents output.

## LinkedIn access policy

LinkedIn profile URLs are routed **directly to Bright Data**, never to Firecrawl
(which refuses linkedin.com by policy). The app does not authenticate to LinkedIn,
use cookies or session tokens, solve CAPTCHAs, drive a browser, or attempt to
bypass any access control. When profile retrieval fails, the run falls back to
public-web research and the UI states plainly that direct retrieval was unavailable.
The app never claims profile access it did not have.

## Testing

```bash
npm test          # 401 unit/integration tests, no network
npm run test:live # real provider calls; each suite self-skips without its key
npm run typecheck
npm run lint
```

The default suite covers URL validation, deduplication, ranking and threshold
behaviour, hallucination rejection, claim adjudication, provider failure paths
(search, LLM, scrape, Bright Data 400/401/404/429/timeout/malformed/empty), the
public-web fallback, and that secrets never appear in logs, errors or API responses.

## Security

All provider calls are server-side. Tokens are read from the environment at call
time and never returned to the client, embedded in URLs, or logged. `.env.local` is
gitignored. `POST /api/runs` is rate limited and can require a shared secret via
`RUN_SHARED_SECRET`.

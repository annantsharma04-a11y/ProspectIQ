// The email-writing rules, in one place.
//
// Extracted verbatim from the analysis prompt so that BOTH callers share one
// definition rather than drifting apart:
//
//   lib/llm/analyze.ts        the research pass, which still declares claims
//                             and (for compatibility) a suggestedMessage
//   lib/generation/write-email.ts  the dedicated writer, which produces the
//                             email the pipeline actually uses
//
// Nothing here was reworded during the extraction. Adding a rule means editing
// this file once; there is no second copy to keep in sync.

export const EMAIL_WRITING_RULES = `MESSAGE:
- 90-130 words, aiming for 100-115. Count the body only, not the subject or the
  signature. Do not pad to reach the count, and do not send a 50-word note: the
  structure below needs room to land.
- Three or four short paragraphs. Vary where the breaks fall between messages;
  identical paragraph boundaries every time read as a template.

STRUCTURE — this is the reasoning the message must carry. Follow the sequence in
the CONTENT, not in the phrasing: the prose stays natural and the joins stay
invisible. A reader should never be able to point at the seams.

  1. ONE VERIFIED FACT      open on a single verified fact, figure or recent
                            event from the supplied evidence: company scale,
                            growth, a launch, a strategic initiative, a
                            portfolio change, a public statement, or work this
                            person demonstrably led.
  2. OPERATIONAL IMPLICATION what work naturally follows from that fact as it
                            grows. A reasonable operational inference is
                            allowed here — asserting how they FEEL about it is
                            not. See the pain rule below.
  3. ONE RELEVANT WORKFLOW  the single workflow that implication points at.
                            Take it from the approved solution's own supported
                            workflows and use cases. Never invent one.
  4. SPECIFIC CAPABILITY    what the product would actually DO in that
                            workflow, in one or two sentences of concrete
                            work. Not a product description, not a category.
  5. ONE APPROVED RESULT    the approved proof statement, verbatim, if one was
                            supplied. Exactly one. If none was supplied, this
                            beat is simply absent.
  6. COLLABORATIVE QUESTION ask how the work is handled today and where you
                            could be useful. A question, not a diagnosis.
  7. LOW-PRESSURE INVITATION one short, unpushy suggestion of a call.

- ONE FACT ONLY. Not three statistics, not two announcements, not a leadership
  fact plus a launch plus a funding round. The message should read as researched,
  never as scraped. Extra facts do not strengthen it; they reveal the scraping.
- INFER THE WORK, NEVER INVENT THE PAIN. This is the line that matters most in
  step 2, and it is narrow:
    Allowed:     "As that portfolio grows, keeping reporting consistent across
                 each product gets harder."
    Not allowed: "I'm sure your team is struggling with reporting."
                 "You're probably dealing with a lot of manual work."
                 "This must be a bottleneck." "I imagine that's frustrating."
  You do not know their experience. Describe the work, not their feelings about
  it — unless a supplied source explicitly establishes the difficulty, in which
  case cite it like any other claim.
- Describe the capability as WORK, not as a platform. Write what it does in
  their workflow: "pull the agreed metrics from existing systems, flag missing
  or inconsistent inputs, and prepare the first update for review." Never open
  the message with the product, and never introduce it as a category ("an
  AI-powered platform that transforms operations").
- The close is collaborative. "I'd be keen to understand how this is handled
  today and where we could be useful" — then one low-pressure invitation such as
  "would be great to talk it through on a short call". Vary the wording. Never
  push a demo, never manufacture urgency.

OUTPUT SHAPE: suggestedMessage contains the EMAIL ITSELF and nothing else.
Open with a greeting on the recipient's first name ("Hi David,"), then the
paragraphs, then a short sign-off on the sender's name. No headings, no bullet
points, no numbered lists, no bold or markdown, no labels naming the parts of
the structure, no preamble such as "Here is your email", and no commentary
about your own reasoning before or after it. The structure above is how you
THINK; the reader only ever sees prose.

SUBJECT: short and understated, naming the verified fact or the workflow —
"Reporting across New Bets", "Campaign operations", "Vendor onboarding". Never
"Quick question", "Partnership opportunity", "AI for [Company]", and never a
clickbait or urgent framing.

VOICE — write like a person, not like a system reporting its research:
- Human and grounded. Quietly confident. Reflective rather than declarative.
  Plainspoken. Warm without being sentimental. Direct and specific.
- Write PEER TO PEER, especially to founders, partners and senior leaders. Not
  deferential, not impressed, not over-explaining. You are a smart person who did
  a little homework and has a legitimate reason to make contact.
- Short sentences. Natural contractions (I'd, you're, it's, we've). Simple words.
  One idea per sentence. Vary the length. Two to four short paragraphs, and do
  not use the same shape for every message.
- A usable arc, not a template: what you noticed, why it caught your attention,
  why you are relevant, a low-pressure close. Vary the opening, the transitions
  and the close between messages.
- ONE good specific detail beats five. Do not stack "I noticed your role, your
  hiring, your expansion and your launch". That is research on display.
  Personalisation should feel incidental, not performed.

NEVER WRITE:
- Manufactured contrast: "it's not X, it's Y", "it's not just X, it's Y",
  "less about X, more about Y", "the real question isn't", "X isn't the answer".
  No rhetorical questions as transitions. No sentences built for symmetry or
  designed to sound quotable.
- Essayistic filler: "here's the thing", "the truth is", "what struck me",
  "it's worth noting", "that said", "ultimately", "which is why", "let me
  explain", "at the end of the day", "in today's world", "in an era of".
- Marketing vocabulary: meaningful, impactful, compelling, powerful, profound,
  transformative, revolutionary, game-changing, unlock, reimagine, leverage,
  synergy, north star, journey, at scale, increasingly, seamlessly, robust,
  innovative, cutting-edge, exciting, dynamic, unique, world-class,
  best-in-class.
- Praise: impressive, remarkable, visionary, forward-thinking, incredible,
  outstanding, exceptional, admirable, amazing. They know their own background;
  the verified fact is the reason for writing, and a compliment adds nothing.
- Fake familiarity: "I've been following your work", "I've long admired",
  "I know how challenging this must be", "I can imagine how". You do not know
  them and you do not know how they feel. Say what the evidence shows:
  "the hiring pattern suggests the team is investing here", and only if it does.
- Openers: "hope you're doing well", "I hope this email finds you well",
  "I recently came across your profile", "I was impressed by your background",
  "I wanted to reach out", "I wanted to introduce myself", "I came across your
  company", "Given your role...", "As a leader in...". Open on the verified
  fact instead — it is the whole reason this person is being written to.
- Pushy closes: "hop on a quick call", "can I steal 15 minutes", "book time
  here", "let's connect ASAP". Prefer "curious whether this is something you're
  looking at", "happy to compare notes if it's relevant", or simply a question.
  Do not force a call to action the evidence does not justify.
- Em dashes. Use periods and commas. No exclamation marks.

Good: "Saw the hiring push around data infrastructure at Acme."
Bad:  "I was really impressed by the exciting work Acme is doing in data
       infrastructure."
Good: "I noticed the push into AI infrastructure. We work with teams dealing
       with a similar shift."
Bad:  "Your recent expansion into AI infrastructure is both impressive and
       highly relevant to the broader changes we are seeing across the industry."

Keep the sender description to one short sentence: "we help teams handle X".
Not a pitch. No invented customers, results or credibility.

APPROVED PROOF: the customer result in the message, if there is one, may come
from exactly one place — the APPROVED ZAMP PROOF block supplied below. It has
already been selected for this prospect; it is not yours to choose, and there
is no catalog to choose from. Two options only: reproduce its approved
statement WORD FOR WORD, or write no customer result at all.
  - Never paraphrase, compress, extend, split or merge it.
  - Never alter a number, a customer name, a timeframe or a unit inside it.
  - Never derive a second result from it, and never add a second proof.
  - Never write an unattributed stand-in — "one client saw", "a large retailer
    reduced", "teams typically see" — when no proof was supplied. An
    anonymous result is still a fabricated result.
If no proof block appears below, the message simply has no customer result.
That is a correct, expected outcome and never a reason to supply one.

APPROVED SOLUTION: if one is supplied below, it is the ONLY product you may
describe. You may use its name, description and use cases to frame the
message — you may NOT invent capabilities or outcomes beyond what is stated,
and you may NOT apply it to anything listed as a non-use-case. If no approved
solution is supplied, describe the sender's offering only in the general terms
given above; do not name or imply a specific product.

Do not fake humanity. No deliberate typos, no forced casualness, no artificial
imperfections. Plain, careful writing already reads as human.

Before returning the message, check it: could this be sent to a different person
with the name swapped and still read the same? Would a skeptical executive call
it PR? Does any sentence exist mainly to sound impressive? If so, simplify it.
- The message must be SPECIFIC to the selected hook: it should be impossible to
  send the same text to a different prospect without rewriting it.
- WRITE THE OPENER AS AN OBSERVATION, NOT A HEADLINE OR A RESEARCH SUMMARY.
  Reason privately in this order, then write only the last step:
    1. what the evidence actually says
    2. what it implies
    3. why that matters to THIS person given their role
    4. one natural sentence a salesperson would actually write
  The research is your input; it is not the message. Do not reproduce your
  summary of the company back to someone who works there.
  The opening sentence must:
    * make ONE observation, not stack several facts together
    * run roughly 15-30 words
    * connect to what this person actually does
    * sound like a human wrote it to another human
  It must NOT:
    * be the source title, the quoted text, or the signal with words swapped
    * open with "Given that…", "As the largest/leading…", "With over N customers…"
      or any similar briefing construction
    * describe the company's business back to them ("X operates as the largest Y
      handling millions of Z") — they know what their company does
    * pile on superlatives or corporate adjectives
  A useful test: if the sentence could appear verbatim in a research report, it
  is wrong. Rewrite it as something you would actually type to a person.
- NEVER write a placeholder such as "[Your Name]", "[Sender Name]", "<Your Name>"
  or "{{sender_name}}". Sign off with the sender name given to you above. If no
  sender name was given, end after the call to action with no signature block.
- If insufficientEvidence is true, set suggestedMessage to an empty string and
  write no message at all. A run with no verified hook produces no draft.
- List EVERY factual claim the message makes in messageClaims. For each, set:
    type — what kind of assertion it is:
      PROSPECT_FACT        a fact about the person (role, tenure, activity)
      COMPANY_FACT         a fact about their company
      EXTERNAL_EVENT       a dated event: funding, launch, acquisition, partnership
      SENDER_OFFERING      what the SENDER sells ("we build AI agents for AP")
      SENDER_CAPABILITY    what the sender's product can do ("it reconciles invoices")
      SENDER_OUTCOME_CLAIM a results/performance claim about the sender's product
                           ("cuts processing time 80%", "used by 200 finance teams")
      GENERIC_LANGUAGE     a pleasantry, question or call to action
    verdict — SUPPORTED, UNSUPPORTED or UNCERTAIN, judged against the evidence.
  PROSPECT_FACT, COMPANY_FACT and EXTERNAL_EVENT require evidence: cite the
  source URL in evidence_url. SENDER_OFFERING, SENDER_CAPABILITY and
  GENERIC_LANGUAGE do NOT require third-party evidence — mark them SUPPORTED
  with a null evidence_url.
  AVOID SENDER_OUTCOME_CLAIM entirely: do not put percentages, customer counts,
  time savings or ROI figures in the message unless they appear in the sender
  brief you were given. Describe what the product does, not how well it performs.
  Be strict about world-claims: unstated specifics are UNSUPPORTED even when
  plausible.`;

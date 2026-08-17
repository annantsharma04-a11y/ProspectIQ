// Representative generated-message samples for voice evaluation.
//
// These are SYNTHETIC drafts written to exercise the style checker, modelled on
// the message shapes the pipeline actually produces. Company and person names
// are placeholders; no real prospect data from the database appears here.
//
// Each scenario mirrors a real pipeline state so the checker is exercised
// against the situations it will actually see.

export interface VoiceSample {
  scenario: string;
  /** The verified quote the hook rests on, exempt from style checks. */
  quote: string | null;
  /** A draft in the old, generated-sounding register. */
  before: string;
  /** The same reason to make contact, written in the target voice. */
  after: string;
}

export const VOICE_SAMPLES: VoiceSample[] = [
  {
    scenario: '1. Strong verified signal — company hiring push',
    quote: 'Northwind is hiring six data engineers to rebuild its reporting stack.',
    before: `Hi Priya,

I was really impressed by the exciting work Northwind is doing in data infrastructure. Your impressive leadership and visionary approach to building a robust, scalable platform particularly stood out to me.

It's not just about hiring, it's about transforming how the entire organisation leverages data at scale. Here's the thing: we help innovative teams unlock meaningful outcomes in exactly this area.

Would you be open to a quick 15-minute call?

Best,
Sam`,
    after: `Hi Priya,

Saw that Northwind is hiring six data engineers to rebuild the reporting stack. That's a big lift to take on alongside everything else the team is running.

We work with data teams going through the same rebuild, mostly on the pipeline reliability side.

Curious whether that's the part you're most worried about, or whether the harder problem is somewhere else.

Best,
Sam`,
  },
  {
    scenario: '2. Weak evidence — one dated public post, nothing more',
    quote: 'We have started publishing our incident reports publicly.',
    before: `Hi Marcus,

I've been following your work at Halcyon for some time and I know how challenging it must be to maintain reliability at scale in today's world.

Your recent post about incident reports was both compelling and profound. Ultimately, transparency is a game-changing differentiator.

Can I steal 15 minutes to explore synergies?

Best,
Sam`,
    after: `Hi Marcus,

Noticed Halcyon started publishing its incident reports publicly. Not many teams are willing to do that, and it changes how carefully the write-ups have to be worded.

We build tooling for engineering teams that report externally. Mostly it takes the drafting and review load off the on-call engineer, who usually has the least time to spend on it.

I don't know whether that's a real cost for you or just part of the routine by now.

Happy to compare notes if it's useful.

Best,
Sam`,
  },
  {
    scenario: '3. No useful personalization available — truthful, less specific',
    quote: null,
    before: `Hi Dana,

I recently came across your profile and was intrigued by your remarkable journey. Your outstanding track record in finance operations is truly inspiring.

We are a leading, innovative platform reimagining the way modern organizations handle accounts payable, delivering transformative results at scale.

Let's connect ASAP!

Best,
Sam`,
    after: `Hi Dana,

I'm reaching out because you run finance operations at Kestrel, and I couldn't find much public detail about how your team handles invoice processing.

We build software for AP teams doing high volumes of manual matching. That's the whole pitch.

If that's not a problem you have, no need to reply. If it is, I'd be interested to hear how you're handling it now.

Best,
Sam`,
  },
  {
    scenario: '4. Senior executive — peer to peer, not deferential',
    quote: 'Orion has opened a second engineering office in Lisbon.',
    before: `Dear Ms Okafor,

It is a genuine privilege to reach out to a leader of your calibre. Your visionary stewardship of Orion has been nothing short of remarkable.

The expansion into Lisbon is an exciting and powerful statement of intent. It's not merely growth, it's a bold reimagining of what a distributed organisation can be.

I would be honoured to book time with you.

Best regards,
Sam`,
    after: `Hi Adaeze,

Saw Orion opened a second engineering office in Lisbon. Splitting a team across two sites usually surfaces process gaps that were invisible when everyone sat in the same building.

We work with engineering orgs at exactly that point. Most of what we do is handover and on-call coverage across time zones, which is where the friction tends to show up first.

You may well have solved this already, in which case ignore me. Worth a conversation if it's still on your radar.

Best,
Sam`,
  },
  {
    scenario: '5. Product launch event — one detail, not five',
    quote: 'Vela launched its API marketplace in March.',
    before: `Hi Tom,

I noticed your role as VP Product, your recent hiring across engineering, your expansion into Europe, your API marketplace launch, and your background at two prior startups.

The launch is a compelling and impactful milestone. That said, the real question isn't whether the marketplace succeeds, it's whether the platform can scale seamlessly.

Would you be open to a quick call to discuss?

Best,
Sam`,
    after: `Hi Tom,

Saw Vela launched the API marketplace in March. Opening a platform to third-party developers tends to change what support looks like fairly quickly, usually within the first couple of quarters.

We work with teams just after that shift, mainly on developer onboarding and the docs that stop the same question arriving twenty times.

Interested to hear how the first few months have actually gone, if you're up for sharing.

Best,
Sam`,
  },
];

/**
 * Genuinely good SHORT drafts, 40–59 words.
 *
 * These exist to prove the floor is not a quality proxy. Each is built on one
 * verified detail, says why the sender is relevant, and closes without pressure.
 * Padding any of them to 60 words would mean adding a sentence that carries no
 * information, which is exactly the artificial register the voice policy exists
 * to prevent.
 */
export const SHORT_SAMPLES: {
  scenario: string;
  quote: string;
  /** The verified specifics the draft must still carry, however it words them. */
  anchors: string[];
  text: string;
}[] = [
  {
    scenario: 'Hiring signal, single detail, 40s',
    quote: 'Northwind is hiring six data engineers to rebuild its reporting stack.',
    anchors: ['Northwind', 'six data engineers'],
    text: `Hi Priya,

Saw Northwind is hiring six data engineers for the reporting rebuild. That's a lot of parallel work while the old stack still has to run.

We work with data teams mid-rebuild, mostly on pipeline reliability.

Curious whether that's the hard part for you, or something else.

Best,
Sam`,
  },
  {
    scenario: 'Product launch, peer to peer, 50s',
    quote: 'Vela launched its API marketplace in March.',
    anchors: ['Vela', 'API marketplace', 'March'],
    text: `Hi Tom,

Saw Vela opened the API marketplace in March. Third-party developers tend to change what support looks like within a quarter or two.

We work with teams right after that shift, mainly on developer onboarding.

Interested to hear how the first few months have gone, if you're up for sharing.

Best,
Sam`,
  },
  {
    scenario: 'Senior leader, office expansion, 50s',
    quote: 'Orion has opened a second engineering office in Lisbon.',
    anchors: ['Orion', 'Lisbon'],
    text: `Hi Adaeze,

Saw Orion opened a second engineering office in Lisbon. Two sites usually surface handover gaps that nobody noticed when everyone sat together.

That's most of what we work on with engineering orgs.

You may have this covered already. If not, happy to compare notes.

Best,
Sam`,
  },
];

/**
 * Drafts that must be REJECTED by the style checker, one per prohibited family.
 * Each is otherwise well-formed, so only the named pattern can be the cause.
 */
export const PROHIBITED_SAMPLES: { rule: string; text: string }[] = [
  {
    rule: 'manufactured contrast',
    text: 'Hi Priya, saw the hiring push at Northwind and wanted to ask about it. It\'s not just about headcount, it\'s about the reporting stack underneath it. We work with data teams going through the same rebuild, mostly on pipeline reliability. Curious whether that is the part that worries you most right now, or whether the harder problem sits somewhere else entirely for your team. Best, Sam',
  },
  {
    rule: 'essayistic filler',
    text: 'Hi Priya, saw the hiring push at Northwind and wanted to ask about it. Here\'s the thing: rebuilding a reporting stack while the business keeps running is genuinely hard work. We work with data teams going through the same rebuild, mostly on pipeline reliability. Curious whether that is the part that worries you most right now, or something else. Best, Sam',
  },
  {
    rule: 'marketing vocabulary',
    text: 'Hi Priya, saw the hiring push at Northwind and wanted to ask about it. Rebuilding reporting is a transformative step that helps teams unlock value at scale across the business. We work with data teams going through the same rebuild, mostly on pipeline reliability. Curious whether that is the part that worries you most right now. Best, Sam',
  },
  {
    rule: 'generic praise',
    text: 'Hi Priya, your impressive leadership at Northwind and your remarkable track record in data caught my attention this week. Rebuilding a reporting stack is hard work under any circumstances. We work with data teams going through the same rebuild, mostly on pipeline reliability. Curious whether that is the part that worries you most right now. Best, Sam',
  },
  {
    rule: 'fake familiarity',
    text: 'Hi Priya, I\'ve been following your work at Northwind for a while now and wanted to reach out. I know how challenging a reporting rebuild must be with everything else running. We work with data teams going through the same rebuild, mostly on pipeline reliability. Curious whether that is the part that worries you most right now. Best, Sam',
  },
  {
    rule: 'banned opener',
    text: 'Hi Priya, I hope this email finds you well. I recently came across your profile and wanted to reach out about the reporting work at Northwind. We work with data teams going through the same rebuild, mostly on pipeline reliability. Curious whether that is the part that worries you most right now, or something else entirely. Best, Sam',
  },
  {
    rule: 'pushy CTA',
    text: 'Hi Priya, saw the hiring push at Northwind and wanted to ask about it. Rebuilding a reporting stack while the business keeps running is hard. We work with data teams going through the same rebuild, mostly on pipeline reliability. Can I steal 15 minutes this week to walk you through what we have seen elsewhere? Best, Sam',
  },
  {
    rule: 'em dash',
    text: 'Hi Priya, saw the hiring push at Northwind — six data engineers is a serious commitment to the reporting rebuild. We work with data teams going through the same thing, mostly on pipeline reliability. Curious whether that is the part that worries you most right now, or whether the harder problem is somewhere else. Best, Sam',
  },
  {
    rule: 'exclamation',
    text: 'Hi Priya, saw the hiring push at Northwind and wanted to ask about it! Rebuilding a reporting stack while the business keeps running is hard work. We work with data teams going through the same rebuild, mostly on pipeline reliability. Curious whether that is the part that worries you most right now, or something else. Best, Sam',
  },
];

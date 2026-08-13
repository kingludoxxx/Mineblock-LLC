/**
 * Golden set for the Brief Pipeline.
 *
 * Six real competitor scripts spanning the structures the generator actually
 * meets. Each carries the properties a correct clone must satisfy, so the
 * harness asserts BEHAVIOUR, not exact wording — the output is a model's and
 * will never be byte-stable, but "a framed list keeps its negation" is.
 *
 * Add a fixture whenever a new failure class is found in production. That is
 * how this stops being a snapshot and becomes a regression net.
 */

export const FIXTURES = [
  {
    id: 'framed-list-neck',
    note: 'Reverse-psychology framed list. The frame IS the ad; every hook must carry it, and the NEGATION is the creative.',
    architecture: 'FRAMED_LIST',
    hookCount: [3, 3],
    // the source's signature device — a correct clone must keep the negative
    requireHookPattern: /shouldn'?t|should not|don'?t|do not|never/i,
    requireAllHooksMatch: /three reasons|3 reasons/i,
    script: `Three reasons why you shouldn't put this Italian cream on your turkey neck. First, not only does it work, but it works fast. Within a week, neck skin feels smoother and tighter. By week four, the turkey neck is pulling back. By week eight, that wobble under your chin is gone, and your jawline is visible again. And it's all thanks to retinal palmitate, which wakes up collagen cells that went dormant after hitting 50, so your neck starts rebuilding itself while you sleep. Second, it's super easy to use. The entire routine is one cream, 20 seconds before bed. Apply it to your neck and go to sleep. It absorbs instantly, no grease or smell. Third, it's almost always sold out. Serlino Lab is a family-owned Italian lab that's been running for decades. Every bottle is produced by hand, which means there are only a few hundred available at any time. Men get furious when they see that it is out of stock after just seven days, probably because once men try it, they keep coming back. If you're crazy enough to try it, Serlino Lab is having its worst sale ever, up to 64% off. Click below if you dare.`,
  },
  {
    id: 'reversal-fakeout',
    note: 'Fake-out reversal. The apparent negative that flips is the whole creative and must survive into H1.',
    architecture: 'REVERSAL',
    hookCount: [3, 3],
    requireHookPattern: /return(ing)?|send(ing)? (it )?back|refund/i,
    script: `This is why I'm returning the micro-needling system by Seranova. It's not that I don't like it. I actually finished two applications already and my skin is actually having the biggest glow up I've ever seen. It's not that it's not safe. It comes individually wrapped, so it's completely sterile. It's not that it's low quality because the serum is loaded up with peptides and really great things for your skin. And the micro-needles are 24 carats, which allow that serum to go deeper into the layers of your skin. Which is something that my topical serums actually can't do for me. Also creating little micro channels, kind of tricking my skin into creating new collagen. The reason I'm returning this is because I just looked at the price on TikTok Shop versus off TikTok Shop. It is way lower. They're running some kind of crazy deal right now. Maybe it's for Mother's Day or because it's a new launch, but I'm definitely returning this and getting it right there.`,
    // the source's sales channel must NOT survive — it is their business, not ours
    forbidBodyPattern: /tiktok shop|mother'?s day/i,
  },
  {
    id: 'story-vsl',
    note: 'Long-form documentary VSL. Multiple genuine doors — this is the only architecture where distinct hooks are correct.',
    architecture: 'STORY',
    hookCount: [3, 5],
    script: `This is a true story that was submitted two weeks ago to our investigation team. Mindy, a 54 year old woman from Arizona, was two weeks away from getting a risky expensive arm lift surgery because her flabby arms had become completely unbearable. Her dermatologist told her countless times that surgery was the only hope she had if she didn't want to live the rest of her life with constant embarrassment and loose sagging skin. But after Mindy's old friend recommended she try this little known invention released to the public just three weeks ago, everything changed. Mindy claims that within seven days her flabby arms were almost completely gone and her dermatologist told her to cancel the surgery. But now scientists studying Mindy's case found something shocking. The invention Mindy used works to reverse 95 percent of flabby arm cases and it has already taken the United States by storm. The problem is most of us have been lied to about flabby arms. Most of us are told by our dermatologists that the cause is weight, lack of exercise, age or genetics. But these dermatologists are flat out wrong. In November 2025, researchers at the University of Chicago determined the real root cause. It is a rarely discussed problem called collagen collapse, the shutdown of your arms collagen factories caused by hormone changes after 40.`,
  },
  {
    id: 'promo-ugc',
    note: 'Short promo. The offer is the ad; few hooks, and the opener is the signature.',
    architecture: 'OFFER',
    hookCount: [2, 5],
    script: `Have you still not bought Myoglow because you think it's expensive? Myoglow is officially half off the original price. The best part? Using the button below this video, you'll get two extra collagen-activating serums for free with your order. Unless you live under a rock, you've seen this at-home arm-firming device everywhere on Facebook. They say it's 13 times more powerful than your expensive creams and tricep workouts, and I think that might actually be true because these are my results after just three weeks, and I'm only using it five minutes a day while watching Netflix.`,
  },
  {
    id: 'long-vsl-11k',
    note: 'Long source. Regression guard for the parser truncation that produced "body must be a non-empty string" at 11,516 chars.',
    architecture: null,          // any
    hookCount: [3, 5],
    minBodyChars: 2000,
    script: null,                // built at run time by repeating the story VSL
    buildLong: true,
  },
];

/** Devices a hook may never lead on, whatever the body says. */
export const SPEC_HOOK_RX =
  /\b(one|two|three|1|2|3)\s+(red\s+)?(light|lights|wavelength|wavelengths)\b|\bwavelengths?\b|\b\d+\s?mm\b|\bothers?\s+use\b|\bmost\s+devices\b/i;

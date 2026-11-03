# UX review

Instructions for a fresh reviewer (a Claude subagent, or a person) who looks at pages the way a
new user would, before the owner does. The reviewer gets screenshots and one line per page on what
it is for, nothing else: no code, no spec, no history. Knowing how a page was built makes it
easier to forgive.

Who the reviewer is: <<a person who has never seen this app, for example "a collector" or "a new
user who does not know the math behind it">>.

## What the reviewer is given
- Screenshots of each changed page: phone, wide and dark (and each install language).
- One line per page: what it is for and who opens it.

## What to look for
- Can a first-time user tell what the page is for and what to do next?
- Labels, units and numbers: clear, consistent across pages, never contradicting each other.
- Phone: nothing cut off, tap targets large enough, no sideways scrolling.
- Dark mode: everything readable.
- Empty, loading and error states make sense.
- <<If there is no docs/trust-review.md: for every number, hint or setting, could someone act
  wrongly by reading it wrong?>>

## How to report
At most 10 findings, most important first: `[fix|ask] <page> > <part>: what a user would get
wrong; one concrete change`. For an ask, give the options and the one you recommend. No praise.

# Field — Vision

Field turns scope and rates into quotes and invoices an earthworks operator can
trust.

It is for the operator who prices and bills the work. Finished feels like this:
they build a quote, see which rates and rules produced every price, correct one
deliberately, send a clean document, and invoice against it, all without
calling a developer. Every document a customer was sent can be found again,
exactly as it was sent, with who sent it.

Field is also a quote engine that other systems drive. Its API, CLI and MCP are
typed, validated, deterministic and explainable, so an external AI system can
build, price and revise quotes through it reliably while operators keep a
polished interface and good-looking documents.

Field was built for Embark Landscaping & Earthworks and is open source so any
operator can run their own installation. The property never traded away: a price is only ever what the
operator's own catalogue and deliberate corrections say it is.

## Standing decisions

### Why does Field call no models?

AI systems drive Field from outside, through its typed contract. That keeps
every price deterministic and explainable: the same inputs give the same quote,
and a reviewer can trace it without asking what a model was thinking. Which
model to use, and what it costs, belongs to the system doing the driving.

### Why does every price come from the catalogue?

Operators have to see which rates produced a price and change them on purpose.
When the catalogue is unavailable, pricing is blocked rather than filled in
from code defaults, because a believable number nobody can trace is worse than
no number.

### Why is a sent document never changed?

What a customer was sent is a commercial commitment, and invoices, disputes and
follow-ups depend on knowing exactly what it said. Changing a sent quote makes a
new version; the sent one stays as it was, attributed to whoever sent it.

### Why does each customer get its own installation?

Customers' quotes, contacts and credentials must never meet. Each installation
has its own data, configuration and secrets, and the product improves without
depending on any one customer's private data, credentials or infrastructure.

## Out of scope

- Job management: scheduling, dispatch, statuses and tasks beyond what a quote
  or invoice needs as its container. The customer's job-management system owns
  the job; duplicating it splits the record.
- Field capture: voice recording, transcription, and photo or site evidence
  capture. Other vendors and systems capture the site and supply quote inputs;
  Field prices what they supply.
- AI inside Field. Field calls no models (see above).
- Acting as the authoritative CRM, project-management, accounting or workforce
  planning system. Those records belong to the systems built for them; Field
  owns the quotes and invoices.
- Storing customer credentials, or making an external SaaS product an implicit
  runtime dependency. Either one would tie a customer's installation to
  something they don't control.

This is a guardrail, not a law of physics. Strong evidence can change it;
record the change in the pull request that edits this file.

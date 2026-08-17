# Charter handoff prompt

For projects whose code was built in a different Claude session. That session knows the codebase;
this one knows the management system. This prompt carries the system's rules over there so the
charter comes back in the right shape.

**How to use:** copy the block below, replace the three `<<…>>` placeholders, paste it into the
session that has the project's repo. Bring the result back and paste it into the project's issue
body here.

Why bother rather than writing the charter here: a charter built from reading the actual code
beats one built from reading a deployed page. The Polarized charter in issue #6 was written the
weaker way and its scoring section is explicitly flagged as unverified.

---

```
I need you to write a project charter for <<PROJECT NAME>>, which you have the code for.

This charter is going into a portfolio management system where scheduled agents do research,
spikes, and drafts against each project every night. The charter is the single input that
determines whether that agent work is useful or is confident, plausible garbage. It is worth
twenty real minutes.

## First, read the code

Do not write anything until you have actually read the repo. Every factual claim in the charter
about how the thing works must come from a file you read. If you are unsure about something,
put it in Open questions rather than asserting it.

## The rules this charter has to satisfy

- **Kill criteria are mandatory.** A project with no kill criteria is not allowed to start.
  If I have not told you my actual thresholds, write your best proposal and mark it clearly as
  provisional — do not present your guesses as my decisions.
- **Definition of done must be concrete and testable.** "I can do X from my phone in under 30
  seconds" is right. "It works well" is useless — an agent will happily declare victory on it.
- **"Explicitly NOT in v1" is a scope firewall.** Name the tempting things that are deferred.
  An empty section here means the scope will creep.
- **Separate what agents can do unattended from what needs me.** Taste, priorities, and anything
  about how it should feel are mine. Research, scaffolding, tests, and diagnosis are theirs.

## Ask me before you write

Ask me any question where you would otherwise be guessing at intent — especially: what the thing
is actually for now that it exists, who it is for, what annoys me about it today, and what would
make me abandon it. Wait for my answers. Do not fill these in for me.

## Output format

One fenced markdown block I can paste straight into a GitHub issue body. It must begin with
exactly these two lines, then the charter:

    Repo: <<OWNER/REPO>>
    Review kill criteria by: <<YYYY-MM-DD>>

Then these sections, in this order, with these exact headings:

    # Charter: <name>
    ## What it is
    ## Why it's worth building
    ## Definition of done for v1
    ## Explicitly NOT in v1
    ## Taste and constraints
    ## Where agents should and shouldn't act
    ## Kill criteria
    ## Open questions

Use `- [ ]` checkboxes for anything in Definition of done that can be verified one item at a time.

## Style

Terse. Lead with the answer. Flag inferences as inferences and uncertainty as uncertainty rather
than smoothing over them. Push back if you think the project is not worth doing or if my stated
goal conflicts with what the code actually is — that is more useful to me than agreement.

Do not commit anything or open a PR. Just give me the block.
```

---

## After it comes back

1. Paste it into the project's issue body in this repo
2. Sanity-check the kill criteria — if they are still the other session's proposal, either replace
   them with your own numbers or leave the `Review kill criteria by` date to force the decision
3. Set the label to `active` when you want the weekly sweep tracking it
4. Check the portfolio cap: at most 10 issues may hold `active` or `hot`

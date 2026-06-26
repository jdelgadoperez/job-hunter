# Using the dashboard

Start the dashboard with `npm run cli -- serve` and open the address it prints. It has five tabs.

## Overview

<!-- SCREENSHOT: the Overview tab -->

Your at-a-glance home: the latest search's results and what changed since last time — companies that
are **new** to the directory and ones that are **no longer listed**. Start a new search from here.

## Matches

<!-- SCREENSHOT: the Matches tab -->

Your ranked roles, best-first, each with its score, shared and missing skills, and rationale. Roles
that have since closed are hidden; flip **Show expired** to see them (dimmed, with an "expired"
badge) — handy for finding a role you already applied to. Why roles expire is explained in the
[re-scan reference](../re-scan-behavior.md).

## Companies

<!-- SCREENSHOT: the Companies tab -->

The companies you track yourself, on top of the public directory. Add one by its careers-page URL,
or remove one you're no longer interested in.

## Skills

<!-- SCREENSHOT: the Skills tab -->

The skills pulled from your resume — the basis for every score. Add ones the parser missed and
remove any that are wrong; better skills mean better matches. Worth a look after your first search.

## Settings

<!-- SCREENSHOT: the Settings tab -->

Your scoring setup — whether an Anthropic API key is configured and which model is used. See the
[FAQ](./faq.md#scoring) for what these change.

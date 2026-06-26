# FAQ & troubleshooting

## Scoring

**What's the difference between Claude scoring and the free scorer?**
With an Anthropic API key, Claude reads each role and your profile and scores the fit semantically,
with a short rationale. Without a key, a free offline keyword scorer is used — faster and private,
but shallower. If a Claude call ever fails, the tool falls back to the free scorer automatically and
notes it; a search never crashes over scoring.

**How do I add or change my API key / model?**
Re-run `npm run setup`, or set these in your local settings:

| Setting | Meaning | Default |
|---|---|---|
| `anthropicApiKey` | Anthropic API key for LLM scoring | unset → heuristic scoring |
| `scorerModel` | Model used for scoring | `claude-sonnet-4-6` |
| `scorerProvider` | LLM provider | `anthropic` |

The `ANTHROPIC_API_KEY` environment variable is honored as a fallback if the setting isn't stored.

**Does re-running a search cost me again?**
Yes, if you use Claude scoring — every search re-scores all currently-open roles, so it re-uses the
API each time. The free scorer costs nothing. (More detail in the
[re-scan reference](../re-scan-behavior.md).)

## Your results

**A role I applied to disappeared — where is it?**
It closed and was marked expired. In the dashboard's **Matches** tab, turn on **Show expired** to
find it.

**What does "no longer listed" mean on the Overview?**
The company left the public directory (or you stopped tracking it). Roles already found stay until
they close on their own.

## Privacy

Everything runs on your machine. Your resume and matches live in a single file on your computer. The
only things that leave your machine are the public job pages the tool reads and — *only if you turn
on LLM scoring* — the role text and your profile sent to Anthropic's API. The tool deliberately
does **not** read sites like LinkedIn or Indeed.

**Where is my data stored?**

- macOS / Linux: `~/.job-hunter/jobhunter.db`
- Windows: `%APPDATA%\job-hunter\jobhunter.db`

Set `JOB_HUNTER_HOME` to move it. Delete the file to start completely fresh.

## Common problems

- **"No profile yet"** — you haven't added a resume. Run `npm run cli -- profile <resume>` or re-run `npm run setup`.
- **A company page won't load / Chromium error** — install the browser the tool uses:
  `npx playwright install chromium chromium-headless-shell`. A single company failing is just a
  warning and doesn't stop the search.
- **Scores look shallow and there's no rationale** — you're on heuristic scoring; add an Anthropic API
  key (re-run setup) for semantic scoring with rationales.
- **Start over completely** — delete the database file above and re-run setup.

---

*For developers: the [project README](../../README.md) and [re-scan behavior reference](../re-scan-behavior.md) cover internals.*

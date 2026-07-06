import { type FormEvent, useEffect, useState } from "react";
import type { SettingsUpdate } from "../api";
import { Button, Card, ErrorNote, Loading } from "../components/ui";
import { useSettings, useUpdateSettings } from "../hooks";

export function Settings() {
  const settings = useSettings();
  const update = useUpdateSettings();

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [homeCountry, setHomeCountry] = useState("");
  const [scanFreshnessHours, setScanFreshnessHours] = useState("");
  const [theMuseKey, setTheMuseKey] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [feedKey, setFeedKey] = useState("");

  // Seed the editable non-secret fields from the server once loaded. Secret keys are write-only, so
  // they stay blank.
  useEffect(() => {
    if (settings.data) {
      setModel(settings.data.scorerModel ?? "");
      setHomeCountry(settings.data.homeCountry ?? "");
      setScanFreshnessHours(settings.data.scanFreshnessHours ?? "");
      setFeedUrl(settings.data.feedUrl ?? "");
    }
  }, [settings.data]);

  if (settings.isPending) return <Loading label="Loading settings…" />;
  if (settings.isError) return <ErrorNote error={settings.error} />;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const payload: SettingsUpdate = {
      scorerModel: model,
      feedUrl,
      homeCountry,
      scanFreshnessHours,
    };
    if (apiKey.trim()) payload.anthropicApiKey = apiKey.trim();
    if (theMuseKey.trim()) payload.theMuseApiKey = theMuseKey.trim();
    if (feedKey.trim()) payload.feedKey = feedKey.trim();
    update.mutate(payload, {
      onSuccess: () => {
        setApiKey("");
        setTheMuseKey("");
        setFeedKey("");
      },
    });
  }

  // Clear a stale "Saved." banner the moment the user edits any field, so it never implies that
  // unsaved edits are persisted.
  function edited<T>(setter: (value: T) => void) {
    return (value: T) => {
      if (update.isSuccess || update.isError) update.reset();
      setter(value);
    };
  }

  return (
    <Card className="max-w-xl">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field
          label="Anthropic API key"
          hint={
            settings.data.hasAnthropicKey
              ? "A key is set. Leave blank to keep it."
              : "Optional — enables LLM scoring."
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => edited(setApiKey)(e.target.value)}
            placeholder={settings.data.hasAnthropicKey ? "••••••••" : "sk-ant-…"}
            className="input"
          />
        </Field>
        <Field label="Scorer model" hint="Defaults to the provider's model when blank.">
          <input
            type="text"
            value={model}
            onChange={(e) => edited(setModel)(e.target.value)}
            placeholder="claude-sonnet-5"
            className="input"
          />
        </Field>
        <Field
          label="Home country"
          hint="Your country (e.g. US). Foreign on-site roles are ranked lower and skipped when deep-scoring. Auto-filled from your resume when possible."
        >
          <input
            type="text"
            value={homeCountry}
            onChange={(e) => edited(setHomeCountry)(e.target.value)}
            placeholder="US"
            className="input"
          />
        </Field>
        <Field
          label="Scan freshness (hours)"
          hint="Skip companies scanned within this many hours on a normal scan (0 = always rescan). Tick “Rescan all” on the dashboard to override for one run."
        >
          <input
            type="number"
            min={0}
            value={scanFreshnessHours}
            onChange={(e) => edited(setScanFreshnessHours)(e.target.value)}
            placeholder="24"
            className="input"
          />
        </Field>
        <Field
          label="The Muse API key"
          hint={
            settings.data.hasTheMuseKey ? (
              "A key is set. Leave blank to keep it."
            ) : (
              <>
                Optional — adds The Muse as a lead source.{" "}
                <a
                  href="https://www.themuse.com/developers/api/v2"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Get a key
                </a>
                .
              </>
            )
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={theMuseKey}
            onChange={(e) => edited(setTheMuseKey)(e.target.value)}
            placeholder={settings.data.hasTheMuseKey ? "••••••••" : "your-muse-key"}
            className="input"
          />
        </Field>
        <Field label="Remote feed URL" hint="Optional — a hosted job feed to merge into scans.">
          <input
            type="url"
            value={feedUrl}
            onChange={(e) => edited(setFeedUrl)(e.target.value)}
            placeholder="https://feed.example.com/jobs"
            className="input"
          />
        </Field>
        <Field
          label="Remote feed key"
          hint={
            settings.data.hasFeedKey
              ? "A key is set. Leave blank to keep it."
              : "Optional — sent when the feed requires authentication."
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={feedKey}
            onChange={(e) => edited(setFeedKey)(e.target.value)}
            placeholder={settings.data.hasFeedKey ? "••••••••" : "feed-anon-key"}
            className="input"
          />
        </Field>
        <p className="text-xs text-faint">
          The job directory is the community-maintained stillhiring.today table — no configuration
          needed.
        </p>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save settings"}
          </Button>
          {update.isSuccess ? <span className="text-sm text-success">Saved.</span> : null}
          {update.isError ? (
            <span className="text-sm text-danger">{String(update.error)}</span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and wrapped here
    <label className="block">
      <span className="text-sm font-medium text-fg">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

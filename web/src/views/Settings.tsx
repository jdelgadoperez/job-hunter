import { type FormEvent, useEffect, useState } from "react";
import type { SettingsUpdate } from "../api";
import { Button, Card, ErrorNote, Loading } from "../components/ui";
import { useSettings, useUpdateSettings } from "../hooks";

export function Settings() {
  const settings = useSettings();
  const update = useUpdateSettings();

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  // Seed the editable fields from the server once loaded (the key is write-only, so it stays blank).
  useEffect(() => {
    if (settings.data) setModel(settings.data.scorerModel ?? "");
  }, [settings.data]);

  if (settings.isPending) return <Loading label="Loading settings…" />;
  if (settings.isError) return <ErrorNote error={settings.error} />;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const payload: SettingsUpdate = { scorerModel: model };
    if (apiKey.trim()) payload.anthropicApiKey = apiKey.trim();
    update.mutate(payload, { onSuccess: () => setApiKey("") });
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
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings.data.hasAnthropicKey ? "••••••••" : "sk-ant-…"}
            className="input"
          />
        </Field>
        <Field label="Scorer model" hint="Defaults to the provider's model when blank.">
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="claude-sonnet-4-6"
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
  hint?: string;
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

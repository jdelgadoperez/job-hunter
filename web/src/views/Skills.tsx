import { X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, Card, CardHeader, Empty, ErrorNote, Loading, PageHeader } from "../components/ui";
import { formatCount } from "../format";
import {
  useAddSkill,
  useProfile,
  useRemoveSkill,
  useSkills,
  useUpdateProfileSkills,
} from "../hooks";

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-md bg-subtle pr-1 pl-2.5 text-sm text-fg">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="flex h-5 w-5 items-center justify-center rounded text-faint transition-colors hover:bg-active hover:text-danger focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </span>
  );
}

function ProfileSkills() {
  const profile = useProfile();
  const dict = useSkills();
  const update = useUpdateProfileSkills();
  const [draft, setDraft] = useState("");

  const skills = profile.data?.skills ?? [];

  // Dictionary terms not already on the profile, offered as type-ahead suggestions.
  const onProfile = new Set(skills);
  const suggestions = (dict.data ?? []).map((s) => s.name).filter((name) => !onProfile.has(name));

  function add(e: FormEvent) {
    e.preventDefault();
    const value = draft.trim();
    if (!value) return;
    update.mutate([...skills, value]);
    setDraft("");
  }

  return (
    <Card>
      <CardHeader
        title="Your skills"
        meta={skills.length > 0 ? formatCount(skills.length) : undefined}
      />
      <p className="mt-1 text-sm text-muted">
        These are matched against every posting. Search the dictionary or type a brand-new skill —
        changes apply on the next scan.
      </p>

      {profile.isPending ? (
        <Loading />
      ) : profile.isError ? (
        <ErrorNote error={profile.error} />
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {skills.length === 0 ? (
              <span className="text-sm text-faint">No skills yet.</span>
            ) : (
              skills.map((s) => (
                <Chip
                  key={s}
                  label={s}
                  onRemove={() => update.mutate(skills.filter((x) => x !== s))}
                />
              ))
            )}
          </div>
          <form onSubmit={add} className="mt-4 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              list="profile-skill-options"
              placeholder="Search the dictionary or add a new skill…"
              className="input mt-0 flex-1"
            />
            <datalist id="profile-skill-options">
              {suggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <Button type="submit" disabled={update.isPending || !draft.trim()}>
              Add
            </Button>
          </form>
          {update.isError ? <ErrorNote error={update.error} /> : null}
        </>
      )}
    </Card>
  );
}

function Dictionary() {
  const dict = useSkills();
  const addSkill = useAddSkill();
  const removeSkill = useRemoveSkill();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState("");

  function add(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    addSkill.mutate({ name: trimmed, category: category.trim() || undefined });
    setName("");
    setCategory("");
  }

  const all = dict.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? all.filter((s) => s.name.includes(needle)) : all;

  return (
    <Card>
      <CardHeader title="Skill dictionary" meta={dict.data ? formatCount(all.length) : undefined} />
      <p className="mt-1 text-sm text-muted">
        The vocabulary the resume parser recognizes. Adding a term here lets future resume uploads
        detect it.
      </p>

      <form onSubmit={add} className="mt-4 flex flex-wrap gap-2">
        <input
          aria-label="Skill name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Skill name"
          className="input mt-0 min-w-40 flex-1"
        />
        <input
          aria-label="Skill category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (optional)"
          className="input mt-0 w-40"
        />
        <Button type="submit" disabled={addSkill.isPending || !name.trim()}>
          Add
        </Button>
      </form>

      {dict.isPending ? (
        <Loading label="Loading dictionary…" />
      ) : dict.isError ? (
        <ErrorNote error={dict.error} />
      ) : all.length === 0 ? (
        <div className="mt-4">
          <Empty>The dictionary is empty.</Empty>
        </div>
      ) : (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter the dictionary"
            placeholder="Filter…"
            className="input mt-4"
          />
          <ul className="mt-3 max-h-96 divide-y divide-rule overflow-auto rounded-md border border-border">
            {shown.map((s) => {
              const removing = removeSkill.isPending && removeSkill.variables === s.name;
              return (
                <li
                  key={s.name}
                  className="flex h-9 items-center justify-between px-3 text-sm hover:bg-raised"
                >
                  <span className="min-w-0 truncate">
                    {s.name} <span className="text-xs text-faint">· {s.category}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeSkill.mutate(s.name)}
                    disabled={removing}
                    aria-label={`Remove ${s.name}`}
                    className="flex h-6 w-6 items-center justify-center rounded text-faint transition-colors hover:bg-subtle hover:text-danger focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
            {shown.length === 0 ? (
              <li className="px-3 py-2 text-sm text-faint">No matches.</li>
            ) : null}
          </ul>
        </>
      )}
    </Card>
  );
}

export function Skills() {
  return (
    <section className="space-y-5">
      <PageHeader
        title="Skills"
        description="What every posting is matched against, and the vocabulary the resume parser knows."
      />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-2">
        <ProfileSkills />
        <Dictionary />
      </div>
    </section>
  );
}

import { type FormEvent, useState } from "react";
import { Button, Card, Empty, ErrorNote, Loading } from "../components/ui";
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
    <span className="inline-flex items-center gap-1 rounded-full bg-subtle px-2.5 py-1 text-sm text-fg">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="rounded text-faint hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        ×
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
      <h2 className="font-semibold text-fg">Your skills</h2>
      <p className="mt-1 text-xs text-faint">
        These are matched against every posting. Search the dictionary or type a brand-new skill —
        changes apply on the next scan.
      </p>

      {profile.isPending ? (
        <Loading />
      ) : profile.isError ? (
        <ErrorNote error={profile.error} />
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
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
          <form onSubmit={add} className="mt-3 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              list="profile-skill-options"
              placeholder="Search the dictionary or add a new skill…"
              className="input flex-1"
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
      <h2 className="font-semibold text-fg">
        Skill dictionary{dict.data ? ` (${formatCount(all.length)})` : ""}
      </h2>
      <p className="mt-1 text-xs text-faint">
        The vocabulary the resume parser recognizes. Adding a term here lets future resume uploads
        detect it.
      </p>

      <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Skill name"
          className="input flex-1"
        />
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (optional)"
          className="input w-44"
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
        <Empty>The dictionary is empty.</Empty>
      ) : (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="input mt-3"
          />
          <ul className="mt-2 max-h-80 divide-y divide-border overflow-auto rounded border border-border">
            {shown.map((s) => {
              const removing = removeSkill.isPending && removeSkill.variables === s.name;
              return (
                <li key={s.name} className="flex items-center justify-between px-3 py-1.5 text-sm">
                  <span>
                    {s.name} <span className="text-xs text-faint">· {s.category}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeSkill.mutate(s.name)}
                    disabled={removing}
                    aria-label={`Remove ${s.name}`}
                    className="rounded text-faint hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    ×
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
    <section className="space-y-4">
      <ProfileSkills />
      <Dictionary />
    </section>
  );
}

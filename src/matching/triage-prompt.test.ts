import type { SkillProfile } from "@app/domain/types";
import { describe, expect, it } from "vitest";
import { buildTriagePrompt, type TriageItem } from "./triage-prompt";

const profile: SkillProfile = {
  skills: ["typescript", "node"],
  roleKeywords: ["backend", "engineer"],
  categories: ["backend"],
};

describe("buildTriagePrompt", () => {
  it("puts the profile in the cacheable system prefix", () => {
    const { system } = buildTriagePrompt(profile, []);
    for (const skill of profile.skills) {
      expect(system).toContain(skill);
    }
  });

  it("lists every item id and title in the user message", () => {
    const items: TriageItem[] = [
      { id: "a", title: "Backend Engineer", location: "Remote" },
      { id: "b", title: "Sales Rep" },
    ];
    const { user } = buildTriagePrompt(profile, items);
    for (const item of items) {
      expect(user).toContain(item.id);
      expect(user).toContain(item.title);
    }
  });
});

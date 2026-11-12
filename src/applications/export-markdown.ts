import { type Application, statusLabel } from "./model";

/**
 * Render applications as markdown, in the same layout the old `jt export` produced (one
 * `## Company | Role` section per application, details as a bullet list, dated notes nested), so
 * existing exports and anything that reads them keep working.
 */
export function applicationsToMarkdown(
  apps: Application[],
  opts: { archived?: boolean } = {},
): string {
  const lines = [
    opts.archived ? "# Archived Applications" : "# Job Applications",
    "",
    "> Exported from job-hunter.",
    "",
    "---",
  ];
  for (const app of apps) {
    lines.push("", `## ${app.company} | ${app.role}`, "");
    lines.push(`- **Status:** ${statusLabel(app.status)}`);
    lines.push(`- **Date Applied:** ${app.dateApplied}`);
    if (app.url) lines.push(`- **URL:** ${app.url}`);
    if (app.source) lines.push(`- **Source:** ${app.source}`);
    if (app.salaryRange) lines.push(`- **Salary Range:** ${app.salaryRange}`);
    if (app.recruiter) lines.push(`- **Recruiter:** ${app.recruiter}`);
    if (app.archived) lines.push("- **Archived:** Yes");
    if (app.notes.length > 0) {
      lines.push("- **Notes:**");
      for (const note of app.notes) lines.push(`  - [${note.date}] ${note.content}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

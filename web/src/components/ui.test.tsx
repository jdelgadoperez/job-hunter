import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar } from "./ui";

/** Read the inline width the bar's fill element resolved to (e.g. "60%"). */
function fillWidth(container: HTMLElement): string {
  const fill = container.querySelector<HTMLElement>("[data-testid='progress-fill']");
  if (!fill) throw new Error("progress fill not rendered");
  return fill.style.width;
}

describe("ProgressBar", () => {
  it("renders the completed fraction as a percentage width", () => {
    const { container } = render(<ProgressBar current={3} total={4} />);
    expect(fillWidth(container)).toBe("75%");
  });

  it("clamps to 100% when current exceeds total", () => {
    const { container } = render(<ProgressBar current={12} total={10} />);
    expect(fillWidth(container)).toBe("100%");
  });

  it("renders 0% when total is zero, without dividing by zero", () => {
    const { container } = render(<ProgressBar current={0} total={0} />);
    expect(fillWidth(container)).toBe("0%");
  });
});

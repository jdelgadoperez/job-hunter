import { describe, expect, it } from "vitest";
import { detectAtsFingerprint } from "./detect-ats-fingerprint";

describe("detectAtsFingerprint", () => {
  it("returns null when no ATS signal is present", () => {
    const html = "<html><body><h1>Careers</h1><p>We are hiring.</p></body></html>";
    expect(detectAtsFingerprint("https://careers.acme.com", html)).toBeNull();
  });

  describe("redirect / final URL signals", () => {
    it("detects Greenhouse when the page redirected to a boards.greenhouse.io URL", () => {
      const match = detectAtsFingerprint(
        "https://boards.greenhouse.io/acme",
        "<html><body>jobs</body></html>",
      );
      expect(match).toEqual({
        platform: "greenhouse",
        connectorSource: "greenhouse",
        signal: "finalUrl",
      });
    });

    it("detects Workday when the page redirected to a myworkdayjobs.com URL", () => {
      const match = detectAtsFingerprint(
        "https://acme.wd1.myworkdayjobs.com/en-US/External",
        "<html></html>",
      );
      expect(match).toEqual({
        platform: "workday",
        connectorSource: "workday",
        signal: "finalUrl",
      });
    });

    it("detects Lever from a jobs.lever.co final URL", () => {
      const match = detectAtsFingerprint("https://jobs.lever.co/acme", "<html></html>");
      expect(match).toEqual({ platform: "lever", connectorSource: "lever", signal: "finalUrl" });
    });
  });

  describe("embedded host signals (script/iframe/link src in HTML)", () => {
    it("detects Greenhouse from an embedded boards.greenhouse.io board on a custom domain", () => {
      const html = `<html><body>
        <div id="grnhse_app"></div>
        <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
      </body></html>`;
      const match = detectAtsFingerprint("https://careers.acme.com", html);
      expect(match).toEqual({
        platform: "greenhouse",
        connectorSource: "greenhouse",
        signal: "embed",
      });
    });

    it("detects Ashby from an embedded jobs.ashbyhq.com host on a custom domain", () => {
      const html = `<html><body>
        <script src="https://jobs.ashbyhq.com/api/non-user-graphql"></script>
      </body></html>`;
      const match = detectAtsFingerprint("https://acme.com/careers", html);
      expect(match).toEqual({ platform: "ashby", connectorSource: "ashby", signal: "embed" });
    });

    it("detects Lever from an embedded api.lever.co reference on a custom domain", () => {
      const html = `<html><body>
        <script>fetch("https://api.lever.co/v0/postings/acme?mode=json")</script>
      </body></html>`;
      const match = detectAtsFingerprint("https://www.acme.com/jobs", html);
      expect(match).toEqual({ platform: "lever", connectorSource: "lever", signal: "embed" });
    });

    it("detects Workday from an embedded myworkdayjobs iframe on a custom domain", () => {
      const html = `<html><body>
        <iframe src="https://acme.wd5.myworkdayjobs.com/en-US/careers"></iframe>
      </body></html>`;
      const match = detectAtsFingerprint("https://careers.acme.com", html);
      expect(match).toEqual({ platform: "workday", connectorSource: "workday", signal: "embed" });
    });

    it("detects SmartRecruiters from an embedded api.smartrecruiters.com reference", () => {
      const html = `<html><body>
        <script src="https://api.smartrecruiters.com/v1/companies/acme/postings"></script>
      </body></html>`;
      const match = detectAtsFingerprint("https://careers.acme.com", html);
      expect(match).toEqual({
        platform: "smartrecruiters",
        connectorSource: "smartrecruiters",
        signal: "embed",
      });
    });
  });

  describe("known platforms without an existing connector", () => {
    it("detects iCIMS (no connector yet) from an embedded careers-icims host", () => {
      const html = `<html><body>
        <iframe src="https://careers-acme.icims.com/jobs/search"></iframe>
      </body></html>`;
      const match = detectAtsFingerprint("https://careers.acme.com", html);
      expect(match).toEqual({ platform: "icims", connectorSource: null, signal: "embed" });
    });
  });

  describe("Workable connector", () => {
    it("reports a workable.com embed as connector-backed", () => {
      const match = detectAtsFingerprint(
        "https://careers.acme.test",
        '<script src="https://apply.workable.com/embed.js"></script>',
      );
      expect(match?.platform).toBe("workable");
      expect(match?.connectorSource).toBe("workable");
      expect(match?.signal).toBe("embed");
    });
  });

  describe("JSON-LD hiringOrganization signal", () => {
    it("falls back to a JSON-LD JobPosting signal when no host fingerprint matches", () => {
      const html = `<html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"JobPosting","title":"Engineer",
           "hiringOrganization":{"@type":"Organization","name":"Acme"}}
        </script>
      </head><body></body></html>`;
      const match = detectAtsFingerprint("https://careers.acme.com", html);
      expect(match).toEqual({ platform: "json-ld", connectorSource: null, signal: "json-ld" });
    });
  });

  describe("precedence", () => {
    it("prefers a final-URL host match over an embedded reference", () => {
      const html = `<iframe src="https://acme.wd1.myworkdayjobs.com/careers"></iframe>`;
      const match = detectAtsFingerprint("https://boards.greenhouse.io/acme", html);
      expect(match?.platform).toBe("greenhouse");
      expect(match?.signal).toBe("finalUrl");
    });

    it("prefers a connector-backed embed over a bare JSON-LD signal", () => {
      const html = `<html><head>
        <script type="application/ld+json">{"@type":"JobPosting"}</script>
        <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
      </head></html>`;
      const match = detectAtsFingerprint("https://careers.acme.com", html);
      expect(match?.platform).toBe("greenhouse");
      expect(match?.signal).toBe("embed");
    });
  });
});

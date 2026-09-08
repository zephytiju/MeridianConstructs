// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fingerprint,
  getEngineProfile,
  type JsonObject,
} from "../../src/index.js";
import { configuredCapabilityProfile } from "../../src/profiles/settings.js";
const fixture = JSON.parse(
  readFileSync("tests/fixtures/collector-clickhouse/input.json", "utf8"),
) as { layouts: Record<string, JsonObject> };
const profile = getEngineProfile("clickhouse-standalone");
function layouts(append = true): JsonObject[] {
  return Object.values(fixture.layouts).map((value) => {
    const { layoutFingerprint: previous, ...content } = value;
    void previous;
    const selected = { ...content, ...(append ? { appendOnly: true } : {}) };
    return { ...selected, layoutFingerprint: fingerprint(selected) };
  });
}
const append = (settings: JsonObject, manifest = false) =>
  configuredCapabilityProfile(profile, settings, manifest).operations[
    "meridian.evidence.append"
  ]!;
describe("configured ClickHouse append-only evidence", () => {
  it("derives the guarantee only from a complete eligible Evidence selection", () => {
    expect(append({ layouts: layouts() }).guarantees).toContain("append-only");
    expect(append({ layouts: layouts(false) }).guarantees).not.toContain(
      "append-only",
    );
    expect(
      append({ layouts: [...layouts().slice(1), layouts(false)[0]!] })
        .guarantees,
    ).not.toContain("append-only");
    expect(append({}).guarantees).not.toContain("append-only");
  });
  it("does not broaden explicit guarantees or unrelated operations and keeps configured limits", () => {
    const configured = configuredCapabilityProfile(
      profile,
      { layouts: layouts(), maxBatchRows: 100 },
      false,
    );
    expect(
      configured.operations["meridian.evidence.append"]!.limits.maxBatchRows,
    ).toBe(100);
    expect(
      configured.operations["meridian.evidence.append"]!.guarantees,
    ).not.toContain("atomic-evidence");
    expect(
      configured.operations["meridian.structured.put"]!.guarantees,
    ).toEqual(profile.operations["meridian.structured.put"]!.guarantees);
    expect(append({ layouts: layouts() }, true).guarantees).not.toContain(
      "append-only",
    );
    expect(
      configuredCapabilityProfile(configured, { layouts: layouts(false) }, true)
        .operations["meridian.evidence.append"]!.guarantees,
    ).not.toContain("append-only");
  });
  it("does not grant Evidence append from structured-only layouts", () => {
    const selected = layouts(false).map((layout) => {
      const { layoutFingerprint: previous, ...content } = layout;
      void previous;
      const changed = {
        ...content,
        resource: {
          ...(content.resource as JsonObject),
          catalog: "structured",
        },
      };
      return { ...changed, layoutFingerprint: fingerprint(changed) };
    });
    expect(append({ layouts: selected }).guarantees).not.toContain(
      "append-only",
    );
  });
  it.each([[], null, true, "layout", [{ appendOnly: true }]])(
    "rejects malformed configured layouts %j",
    (value) => {
      expect(() => append({ layouts: value })).toThrow(
        /invalid public ClickHouse layouts/,
      );
    },
  );
  it("rejects duplicate Resources and mismatched topology", () => {
    expect(() => append({ layouts: [layouts()[0]!, layouts()[0]!] })).toThrow(
      /unique Resources/,
    );
    const selected = layouts();
    const { layoutFingerprint: previous, ...content } = selected[0]!;
    void previous;
    const changed = { ...content, topology: "clickhouse-replicated" };
    selected[0] = { ...changed, layoutFingerprint: fingerprint(changed) };
    expect(() => append({ layouts: selected })).toThrow(/Binding topology/);
  });
});

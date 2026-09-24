import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_FIXED_EN, fixedEnglish } from "../src/core/fixed-messages";
import { parseTemplateFile } from "../src/core/templates";

describe("câu cố định trong mã nguồn", () => {
  it("bản mặc định trùng NGUYÊN VĂN mẫu đã duyệt (cảnh báo bảo mật, chống spam)", () => {
    const { templates } = parseTemplateFile(readFileSync("content/templates/system.md", "utf8"), "system");
    for (const [id, text] of Object.entries(DEFAULT_FIXED_EN)) {
      const t = templates.find((x) => x.id === id);
      expect(t, id).toBeDefined();
      expect(text, id).toBe(t!.answers.en!.trimEnd());
    }
  });

  it("không đọc được mẫu thì dùng bản mặc định", () => {
    expect(fixedEnglish(undefined, "antispam-1")).toBe(DEFAULT_FIXED_EN["antispam-1"]);
  });
});

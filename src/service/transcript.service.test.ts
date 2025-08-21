import { describe, expect, test, mock } from "bun:test";

// Silence logs
mock.module("@/lib/logger.lib", () => ({
  __esModule: true,
  createLogger: () => ({ debug: () => {}, warn: () => {} }),
}));

describe("transcript.service", () => {
  test("hasTranscriptLanguage returns true if language exists in videos.transcriptLanguages", async () => {
    const db = {
      select: (_s: any) => ({
        from: (_t: any) => ({
          where: (_w: any) => ({
            limit: async (_n: number) => [{ transcriptLanguages: ["English", "Spanish"] }],
          }),
        }),
      }),
    } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { hasTranscriptLanguage } = await import("./transcript.service");
    await expect(hasTranscriptLanguage("v1", "English")).resolves.toBeTrue();
    await expect(hasTranscriptLanguage("v1", "German")).resolves.toBeFalse();
  });

  test("getOldestTranscriptLanguage returns earliest created language", async () => {
    const rows = [{ language: "a" }];
    const db = {
      select: (_s: any) => ({ from: (_t: any) => ({ where: (_w: any) => ({ orderBy: (_o: any) => ({ limit: async (_n: number) => rows }) }) }) }),
    } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { getOldestTranscriptLanguage } = await import("./transcript.service");
    const out = await getOldestTranscriptLanguage("v");
    expect(out).toBe("a");
  });

  test("getPreferredTranscriptLanguage prefers English then English (auto-generated), else falls back", async () => {
    // Case 1: English available
    let db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ transcriptLanguages: ["English"] }] }) }) }),
    };
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    let mod = await import("./transcript.service");
    expect(await mod.getPreferredTranscriptLanguage("v")) .toBe("English");

    // Case 2: English (auto-generated)
    db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ transcriptLanguages: ["English (auto-generated)"] }] }) }) }) };
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    // reload module to pick up new mock
    mod = await import("./transcript.service");
    expect(await mod.getPreferredTranscriptLanguage("v")) .toBe("English (auto-generated)");

    // Case 3: none -> fallback calls getOldestTranscriptLanguage
    const oldest = "jp";
    db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ transcriptLanguages: ["fr"] }] }) }) }) };
    mock.module("./transcript.service", () => import("./transcript.service"));
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    const original = await import("./transcript.service");
    // monkey-patch fallback by temporarily mocking getOldestTranscriptLanguage via jest-like require cache isn't trivial in Bun;
    // instead, we simulate by making getOldestTranscriptLanguage run against a different db path
    // Easiest: spy via wrapper call - call actual function but replace its inner select chain
    const { getPreferredTranscriptLanguage, getOldestTranscriptLanguage } = original;
    const getOldest = getOldestTranscriptLanguage.bind({});
    // Provide a mock db for the oldest path
    const db2 = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{ language: oldest }] }) }) }) }),
    } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    // First call preferred -> not found -> call oldest using a temporary re-mock
    const prefPromise = getPreferredTranscriptLanguage("v");
    mock.module("@/db/client", () => ({ __esModule: true, db: db2 }));
    const pref = await prefPromise;
    expect(pref).toBe(oldest);
  });

  test("upsertTranscript returns upserted true on success", async () => {
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
    } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { upsertTranscript } = await import("./transcript.service");
    const res = await upsertTranscript("v1", "en", { segments: [] });
    expect(res.upserted).toBeTrue();
  });

  test("getTranscriptByVideoAndLanguage returns mapped record or null", async () => {
    // Case: found
    let db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ videoId: "v1", language: "en", segments: [], updatedAt: new Date(0) }] }) }) }),
    };
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    let { getTranscriptByVideoAndLanguage } = await import("./transcript.service");
    let out = await getTranscriptByVideoAndLanguage("v1", "en");
    expect(out?.videoId).toBe("v1");

    // Case: not found
    db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) };
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    ;({ getTranscriptByVideoAndLanguage } = await import("./transcript.service"));
    out = await getTranscriptByVideoAndLanguage("v1", "en");
    expect(out).toBeNull();
  });

  test("handles undefined db paths by returning safe defaults", async () => {
    mock.module("@/db/client", () => ({ __esModule: true, db: undefined }));
    const mod = await import("./transcript.service");
    expect(await mod.hasTranscriptLanguage("v", "en")).toBeFalse();
    expect(await mod.getOldestTranscriptLanguage("v")).toBeNull();
    expect(await mod.getPreferredTranscriptLanguage("v")).toBeNull();
    expect(await mod.upsertTranscript("v", "en", { segments: [] })).toEqual({ upserted: false });
    expect(await mod.getTranscriptByVideoAndLanguage("v", "en")).toBeNull();
  });
});

import { describe, expect, test, mock, afterAll } from "bun:test";

// Silence logs
mock.module("@/lib/logger.lib", () => ({
  __esModule: true,
  createLogger: (_s?: string) => {
    const logger: any = { debug: () => {}, warn: () => {}, info: () => {}, error: () => {}, verbose: () => {} };
    logger.child = (_c: string) => logger;
    return logger;
  },
  ...(() => { let level = "info" as any; return { getLogLevel: () => level, setLogLevel: (l: any) => { level = String(l).toLowerCase(); } }; })(),
}));

describe("caption.service", () => {
  test("hasCaptionLanguage reads videos.captionLanguages and checks languageCode", async () => {
    const db = {
      select: (_s: any) => ({
        from: (_t: any) => ({
          where: (_w: any) => ({
            limit: async (_n: number) => [{ captionLanguages: [{ languageCode: "en" }, { languageCode: "id" }] }],
          }),
        }),
      }),
    } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { hasCaptionLanguage } = await import("./caption.service");
    expect(await hasCaptionLanguage("v1", "en")).toBeTrue();
    expect(await hasCaptionLanguage("v1", "jp")).toBeFalse();
  });

  test("getOldestCaptionLanguage returns earliest created", async () => {
    const db = {
      select: (_s: any) => ({ from: (_t: any) => ({ where: (_w: any) => ({ orderBy: (_o: any) => ({ limit: async () => [{ language: "en" }] }) }) }) }),
    } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { getOldestCaptionLanguage } = await import("./caption.service");
    expect(await getOldestCaptionLanguage("v")).toBe("en");
  });

  test("getPreferredCaptionLanguage prefers en, en-US, en-GB then falls back", async () => {
    // en
    let db: any = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ captionLanguages: [{ languageCode: "en" }] }] }) }) }) };
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    let { getPreferredCaptionLanguage } = await import("./caption.service");
    expect(await getPreferredCaptionLanguage("v")).toBe("en");

    // en-US
    db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ captionLanguages: [{ languageCode: "en-US" }] }] }) }) }) };
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    ;({ getPreferredCaptionLanguage } = await import("./caption.service"));
    expect(await getPreferredCaptionLanguage("v")).toBe("en-US");

    // fallback -> oldest
    const oldest = "id";
    const dbPref = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ captionLanguages: [{ languageCode: "fr" }] }] }) }) }) };
    const dbOldest = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{ language: oldest }] }) }) }) }) };
    mock.module("@/db/client", () => ({ __esModule: true, db: dbPref }));
    const prefPromise = (await import("./caption.service")).getPreferredCaptionLanguage("v");
    mock.module("@/db/client", () => ({ __esModule: true, db: dbOldest }));
    expect(await prefPromise).toBe(oldest);
  });

  test("upsertCaption returns upserted true on success", async () => {
    const db = { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }) } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    const { upsertCaption } = await import("./caption.service");
    const res = await upsertCaption("v", "en", { segments: [], words: [] });
    expect(res.upserted).toBeTrue();
  });

  test("getCaptionByVideoAndLanguage returns mapped record and honors targetLanguage null vs value", async () => {
    // Case: targetLanguage null
    let db: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              { videoId: "v", language: "en", targetLanguage: null, segments: [], words: [], updatedAt: new Date(0) },
            ],
          }),
        }),
      }),
    };
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    let { getCaptionByVideoAndLanguage } = await import("./caption.service");
    let out = await getCaptionByVideoAndLanguage("v", "en", null);
    expect(out?.language).toBe("en");
    expect(out?.targetLanguage).toBeNull();

    // Case: not found
    db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    ({ getCaptionByVideoAndLanguage } = await import("./caption.service"));
    out = await getCaptionByVideoAndLanguage("v", "en", "id");
    expect(out).toBeNull();
  });

  test("handles undefined db by returning safe defaults", async () => {
    mock.module("@/db/client", () => ({ __esModule: true, db: undefined }));
    const mod = await import("./caption.service");
    expect(await mod.hasCaptionLanguage("v", "en")).toBeFalse();
    expect(await mod.getOldestCaptionLanguage("v")).toBeNull();
    expect(await mod.getPreferredCaptionLanguage("v")).toBeNull();
    expect(await mod.upsertCaption("v", "en", { segments: [], words: [] })).toEqual({ upserted: false });
    expect(await mod.getCaptionByVideoAndLanguage("v", "en")).toBeNull();
  });

  // Restore real logger after suite
  afterAll(() => {
    mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
  });
});

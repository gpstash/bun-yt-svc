import { describe, expect, test, mock, afterAll } from "bun:test";

// Common logger mock to silence logs
mock.module("@/lib/logger.lib", () => ({
  __esModule: true,
  createLogger: (_scope?: string) => {
    const logger: any = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} };
    logger.child = (_c: string) => logger;
    return logger;
  },
  ...(() => {
    let level = "info" as any;
    return {
      getLogLevel: () => level,
      setLogLevel: (lvl: any) => { level = String(lvl).toLowerCase(); },
    };
  })(),
}));

function makeDbMock() {
  const calls: any[] = [];
  const chain = {
    values: (v: any) => {
      calls.push(["values", v]);
      return {
        onConflictDoUpdate: (_: any) => {
          calls.push(["onConflictDoUpdate"]);
          return Promise.resolve();
        },
      } as any;
    },
  } as any;

  const inserter = {
    insert: (_tbl: any) => {
      calls.push(["insert", _tbl]);
      return chain;
    },
  } as any;

  const selector = {
    select: (_shape: any) => {
      calls.push(["select", _shape]);
      return {
        from: (_tbl: any) => {
          calls.push(["from", _tbl]);
          return {
            where: (_cond: any) => {
              calls.push(["where", _cond]);
              return {
                limit: async (_n: number) => {
                  calls.push(["limit", _n]);
                  return [] as any[];
                },
              };
            },
          };
        },
      };
    },
  } as any;

  const db = { ...inserter, ...selector } as any;
  return { db, calls };
}

describe("video.service", () => {
  test("upsertVideo returns upserted: true when db is available", async () => {
    const { db } = makeDbMock();
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    const { upsertVideo } = await import("./video.service");

    const parsed: any = {
      id: "vid1",
      title: "t",
      author: "a",
      description: "d",
      thumbnails: [],
      category: "c",
      tags: ["x"],
      duration: 10,
      channel: "ch",
      viewCount: 1,
      likeCount: 2,
      isPrivate: false,
      isUnlisted: false,
      isFamilySafe: true,
      publishDate: { raw: "r", formatted: "f" },
      transcriptLanguages: ["English"],
      hasTranscripts: true,
      captionLanguages: [{ languageCode: "en" }],
      hasCaptions: true,
      captionTranslationLanguages: ["id"],
    };

    const res = await upsertVideo(parsed);
    expect(res.upserted).toBeTrue();
  });

  test("getVideoById returns null when no rows", async () => {
    const { db } = makeDbMock();
    mock.module("@/db/client", () => ({ __esModule: true, db }));
    const { getVideoById } = await import("./video.service");

    const out = await getVideoById("missing");
    expect(out).toBeNull();
  });

  test("getVideoById maps DB row to ParsedVideoInfo", async () => {
    const rows = [
      {
        id: "v1",
        title: "T",
        author: "A",
        description: "D",
        thumbnails: [],
        category: "Cat",
        tags: ["t"],
        duration: 111,
        channel: "CH",
        viewCount: 5,
        likeCount: 6,
        isPrivate: false,
        isUnlisted: false,
        isFamilySafe: true,
        publishDateRaw: "raw",
        publishDateFormatted: "fmt",
        transcriptLanguages: ["English"],
        hasTranscripts: true,
        captionLanguages: [{ languageCode: "en" }],
        hasCaptions: true,
        captionTranslationLanguages: ["id"],
        updatedAt: new Date("2024-01-01T00:00:00Z"),
      },
    ];

    const db = {
      select: (_s: any) => ({
        from: (_t: any) => ({
          where: (_w: any) => ({
            limit: async (_n: number) => rows,
          }),
        }),
      }),
    } as any;

    mock.module("@/db/client", () => ({ __esModule: true, db }));
    const { getVideoById } = await import("./video.service");

    const out = await getVideoById("v1");
    expect(out).not.toBeNull();
    expect(out!.video.id).toBe("v1");
    expect(out!.video.publishDate.raw).toBe("raw");
    expect(out!.updatedAt.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  test("gracefully handles undefined db (returns falsy/null)", async () => {
    mock.module("@/db/client", () => ({ __esModule: true, db: undefined }));
    const mod = await import("./video.service");
    const res = await mod.upsertVideo({ id: "x" } as any);
    expect(res.upserted).toBeFalse();
    const got = await mod.getVideoById("x");
    expect(got).toBeNull();
  });
});

// Restore real logger to avoid leaking mocks
afterAll(() => {
  mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
});

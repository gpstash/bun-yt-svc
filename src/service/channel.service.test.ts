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

describe("channel.service", () => {
  test("upsertChannel returns upserted true on success", async () => {
    const db = { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }) } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { upsertChannel } = await import("./channel.service");
    const parsed: any = {
      id: "UC1",
      title: "T",
      description: "D",
      url: "u",
      vanityUrl: "v",
      isFamilySafe: true,
      keywords: ["k"],
      avatar: {},
      thumbnail: {},
      tags: ["t"],
      isUnlisted: false,
      subscriberCount: "1",
      viewCount: "2",
      joinedDate: "2024-01-01",
      videoCount: "3",
      country: "US",
    };

    const res = await upsertChannel(parsed);
    expect(res.upserted).toBeTrue();
  });

  test("getChannelById returns null when empty", async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { getChannelById } = await import("./channel.service");
    expect(await getChannelById("missing")).toBeNull();
  });

  test("getChannelById maps row to ParsedChannelInfo and returns updatedAt", async () => {
    const updated = new Date("2024-02-02T00:00:00Z");
    const rows = [
      {
        id: "UC1",
        title: "T",
        description: "D",
        url: "u",
        vanityUrl: "v",
        isFamilySafe: true,
        keywords: ["k"],
        avatar: {},
        thumbnail: {},
        tags: ["t"],
        isUnlisted: false,
        subscriberCount: "1",
        viewCount: "2",
        joinedDate: "2024-01-01",
        videoCount: "3",
        country: "US",
        updatedAt: updated,
      },
    ];

    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    } as any;
    mock.module("@/db/client", () => ({ __esModule: true, db }));

    const { getChannelById } = await import("./channel.service");
    const res = await getChannelById("UC1");
    expect(res?.channel.id).toBe("UC1");
    expect(res?.updatedAt.toISOString()).toBe("2024-02-02T00:00:00.000Z");
  });

  test("handles undefined db by returning safe defaults", async () => {
    mock.module("@/db/client", () => ({ __esModule: true, db: undefined }));
    const mod = await import("./channel.service");
    const res = await mod.upsertChannel({ id: "UC1" } as any);
    expect(res.upserted).toBeFalse();
    expect(await mod.getChannelById("UC1")).toBeNull();
  });
});

// Restore real logger after suite
afterAll(() => {
  mock.module("@/lib/logger.lib", () => import("@/lib/logger.lib"));
});

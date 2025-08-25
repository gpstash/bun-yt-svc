import { describe, expect, test } from "bun:test";
import { parseChannelInfo } from "@/helper/channel.helper";

function makeChannel(overrides: any = {}) {
  return {
    getAbout: async () => ({
      metadata: {
        description: "about desc",
        subscriber_count: "1,234",
        view_count: "9,876",
        joined_date: { text: "May 10, 2025" },
        video_count: "42",
        country: "US",
      },
    }),
    metadata: {
      external_id: "UC123",
      title: "Chan",
      url: "https://www.youtube.com/channel/UC123",
      vanity_channel_url: "https://youtube.com/@chan",
      is_family_safe: true,
      keywords: ["k1"],
      avatar: { url: "a", width: 1, height: 1 },
      thumbnail: { url: "t", width: 1, height: 1 },
      tags: ["t1"],
      is_unlisted: false,
    },
    ...overrides,
  } as any;
}

describe("parseChannelInfo()", () => {
  test("extracts fields and defaults safely", async () => {
    const out = await parseChannelInfo(makeChannel());
    expect(out.id).toBe("UC123");
    expect(out.title).toBe("Chan");
    expect(out.description).toBe("about desc");
    expect(out.vanityUrl).toContain("@chan");
    expect(out.isFamilySafe).toBe(true);
    expect(out.keywords).toEqual(["k1"]);
    expect(out.subscriberCount).toBe(1234);
    expect(out.joinedDate).toBe("May 10, 2025");
    expect(out.country).toBe("US");
  });

  test("handles missing about metadata gracefully", async () => {
    const ch = makeChannel({ getAbout: async () => ({ metadata: undefined }) });
    const out = await parseChannelInfo(ch);
    expect(out.description).toBe("");
    expect(out.subscriberCount).toBe(0);
    expect(out.viewCount).toBe(0);
    expect(out.joinedDate).toBe("");
    expect(out.videoCount).toBe(0);
    expect(out.country).toBe("");
  });
});

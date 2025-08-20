import { describe, expect, test, mock } from 'bun:test';
import {
  isValidYoutubeChannelUrl,
  isValidYoutubeWatchUrl,
  isValidHandle,
  isValidChannelId,
  isValidVideoId,
  buildChannelUrlFromId,
  buildWatchUrlFromVideoId,
  buildChannelUrlFromHandle,
  buildYoutubeUrlFromId,
} from './navigation.helper';

// Helper to generate unique test names
function tname(prefix: string, url: string) {
  return `${prefix}: ${url}`;
}

describe('isValidYoutubeChannelUrl', () => {
  const valid = [
    'https://www.youtube.com/channel/UCabcdefghijklmno_p-1Qzz',
    'http://youtube.com/@some_handle',
    'https://m.youtube.com/@Some.Handle_123',
    'https://www.youtube.com/c/CustomName',
    'https://www.youtube.com/user/Legacy-Name_1',
    'https://www.youtube.com/@handle/videos',
    'https://www.youtube.com/channel/UCabcdefghijklmno_p-1Qzz/shorts/',
  ];

  const invalid = [
    'https://youtu.be/@handle', // wrong host for channel
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // video, not channel
    'ftp://www.youtube.com/@handle', // wrong protocol
    'https://www.youtube.com/playlist?list=PL123', // not a channel
    'https://www.youtube.com/', // homepage
    'https://www.youtube.com/@aa', // too-short handle
    'https://www.youtube.com/channel/UCshort_id/videos', // invalid channel id length
  ];

  valid.forEach((url) =>
    test(tname('valid channel', url), () => {
      expect(isValidYoutubeChannelUrl(url)).toBe(true);
    }),
  );

  invalid.forEach((url) =>
    test(tname('invalid channel', url), () => {
      expect(isValidYoutubeChannelUrl(url)).toBe(false);
    }),
  );
});

describe('URL builders', () => {
  test('buildChannelUrlFromId returns canonical channel URL', () => {
    const uc = 'UCabcdefghijklmno_p-1Qzz';
    expect(buildChannelUrlFromId(uc)).toBe(`https://www.youtube.com/channel/${uc}`);
    expect(buildChannelUrlFromId(`/channel/${uc}/`)).toBe(`https://www.youtube.com/channel/${uc}`);
    expect(buildChannelUrlFromId(`//channel//${uc}//`)).toBe(`https://www.youtube.com/channel/${uc}`);
  });

  test('buildChannelUrlFromId returns null for invalid', () => {
    expect(buildChannelUrlFromId('UCshort')).toBeNull();
    expect(buildChannelUrlFromId('')).toBeNull();
  });

  test('buildWatchUrlFromVideoId returns watch URL', () => {
    expect(buildWatchUrlFromVideoId('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(buildWatchUrlFromVideoId(' dQw4w9WgXcQ ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('buildWatchUrlFromVideoId returns null for invalid', () => {
    expect(buildWatchUrlFromVideoId('short')).toBeNull();
    expect(buildWatchUrlFromVideoId('')).toBeNull();
  });

  test('buildChannelUrlFromHandle returns channel URL from handle', () => {
    expect(buildChannelUrlFromHandle('@handle123')).toBe('https://www.youtube.com/@handle123');
    expect(buildChannelUrlFromHandle('handle123')).toBe('https://www.youtube.com/@handle123');
    expect(buildChannelUrlFromHandle('/@handle123')).toBe('https://www.youtube.com/@handle123');
  });

  test('buildChannelUrlFromHandle returns null for invalid', () => {
    expect(buildChannelUrlFromHandle('@ab')).toBeNull();
    expect(buildChannelUrlFromHandle('')).toBeNull();
  });
});

describe('isValidYoutubeWatchUrl', () => {
  const valid = [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'http://youtube.com/watch?v=ABCDEFGHIJK',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ];

  const invalid = [
    'https://www.youtube.com/watch', // no v
    'https://youtu.be/short', // too short
    'ftp://youtu.be/dQw4w9WgXcQ', // wrong protocol
    'https://www.youtube.com/@handle', // channel, not video
    'https://www.youtube.com/playlist?list=PL123',
    'https://vimeo.com/123456789', // different site
  ];

  valid.forEach((url) =>
    test(tname('valid watch', url), () => {
      expect(isValidYoutubeWatchUrl(url)).toBe(true);
    }),
  );

  invalid.forEach((url) =>
    test(tname('invalid watch', url), () => {
      expect(isValidYoutubeWatchUrl(url)).toBe(false);
    }),
  );
});

describe('isValidHandle', () => {
  const valid = [
    'handle123',
    '@handle123',
    '/@handle123',
    'Some.Handle_123',
    '/Some-Handle',
    '@abc', // min length 3
    'a'.repeat(30), // max length 30
  ];

  const invalid = [
    'ab', // too short
    '@ab',
    'a'.repeat(31), // too long
    'with space',
    'bad*chars',
    '',
    '   ',
  ];

  valid.forEach((val) =>
    test(tname('valid handle', val), () => {
      expect(isValidHandle(val)).toBe(true);
    }),
  );

  invalid.forEach((val) =>
    test(tname('invalid handle', val), () => {
      expect(isValidHandle(val)).toBe(false);
    }),
  );
});

describe('isValidChannelId', () => {
  const uc = 'UCabcdefghijklmno_p-1Qzz'; // UC + 22

  const valid = [
    uc,
    uc.toLowerCase(),
    `/channel/${uc}`,
    `channel/${uc}`,
    `/channel/${uc}/`,
    `//channel//${uc}//`, // extra slashes trimmed
  ];

  const invalid = [
    'UCshort_id',
    'UAabcdefghijklmno_p-1Qzz', // wrong prefix
    '/channel/UCshort_id',
    '',
    '   ',
  ];

  valid.forEach((id) =>
    test(tname('valid channelId', id), () => {
      expect(isValidChannelId(id)).toBe(true);
    }),
  );

  invalid.forEach((id) =>
    test(tname('invalid channelId', id), () => {
      expect(isValidChannelId(id)).toBe(false);
    }),
  );
});

describe('isValidVideoId', () => {
  const valid = [
    'dQw4w9WgXcQ',
    'ABCDEFGHIJK',
    'a_b-0Z9YxWv',
    ' dQw4w9WgXcQ ', // with spaces
  ];

  const invalid = [
    'short',
    '',
    '   ',
    'too_long_video_id',
    'bad*chars!!',
  ];

  valid.forEach((v) =>
    test(tname('valid videoId', v), () => {
      expect(isValidVideoId(v)).toBe(true);
    }),
  );

  invalid.forEach((v) =>
    test(tname('invalid videoId', v), () => {
      expect(isValidVideoId(v)).toBe(false);
    }),
  );
});

describe('buildYoutubeUrlFromId (shared)', () => {
  test('returns same string when id is already a valid channel/watch URL', () => {
    const ch = 'https://www.youtube.com/@handle123';
    const w = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(buildYoutubeUrlFromId(ch)).toBe(ch);
    expect(buildYoutubeUrlFromId(w)).toBe(w);
  });

  test('builds channel URL from channelId', () => {
    const uc = 'UCabcdefghijklmno_p-1Qzz';
    expect(buildYoutubeUrlFromId(uc)).toBe(`https://www.youtube.com/channel/${uc}`);
    expect(buildYoutubeUrlFromId(`/channel/${uc}/`)).toBe(`https://www.youtube.com/channel/${uc}`);
  });

  test('builds watch URL from videoId', () => {
    expect(buildYoutubeUrlFromId('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(buildYoutubeUrlFromId(' dQw4w9WgXcQ ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('builds channel URL from handle', () => {
    expect(buildYoutubeUrlFromId('@handle123')).toBe('https://www.youtube.com/@handle123');
    expect(buildYoutubeUrlFromId('handle123')).toBe('https://www.youtube.com/@handle123');
    expect(buildYoutubeUrlFromId('/@handle123')).toBe('https://www.youtube.com/@handle123');
  });

  test('returns null for unsupported/invalid id', () => {
    expect(buildYoutubeUrlFromId('')).toBeNull();
    expect(buildYoutubeUrlFromId('   ')).toBeNull();
    expect(buildYoutubeUrlFromId('not a url and not valid id')).toBeNull();
  });
});

describe('resolveNavigationWithCache', () => {
  test('returns cached on hit; resolves and caches on miss with correct key/ttl', async () => {
    // Arrange mocks
    const calls: any[] = [];
    let cache: Record<string, any> = {};

    mock.module('@/lib/cache.util', () => ({
      jitterTtl: (ttl: number) => ttl, // identity for test predictability
    }));

    mock.module('@/lib/redis.lib', () => ({
      redisGetJson: async (key: string) => {
        calls.push({ fn: 'get', key });
        return cache[key] ?? null;
      },
      redisSetJson: async (key: string, val: any, ttl: number) => {
        calls.push({ fn: 'set', key, ttl });
        cache[key] = val;
      },
    }));

    // Dynamically import after mocks are set
    const { resolveNavigationWithCache } = await import('./navigation.helper');

    // Miss path (watch URL)
    const urlWatch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const innertube = { resolveURL: async (_u: string) => ({ type: 'watch', v: 'dQw4w9WgXcQ' }) };
    const config = { VIDEO_CACHE_TTL_SECONDS: 300, CHANNEL_CACHE_TTL_SECONDS: 600 };
    const resWatch1 = await resolveNavigationWithCache(innertube, urlWatch, config);
    expect(resWatch1).toEqual({ type: 'watch', v: 'dQw4w9WgXcQ' });
    expect(cache[`yt:navigation:watch:${urlWatch}`]).toEqual(resWatch1);

    // Hit path (watch URL)
    const resWatch2 = await resolveNavigationWithCache(innertube, urlWatch, config);
    expect(resWatch2).toEqual(resWatch1);

    // Miss path (channel URL)
    const urlChannel = 'https://www.youtube.com/@handle123';
    const resChannel1 = await resolveNavigationWithCache(
      { resolveURL: async (_u: string) => ({ type: 'channel', h: '@handle123' }) },
      urlChannel,
      config,
    );
    expect(resChannel1).toEqual({ type: 'channel', h: '@handle123' });
    expect(cache[`yt:navigation:channel:${urlChannel}`]).toEqual(resChannel1);

    // Hit path (channel URL)
    const resChannel2 = await resolveNavigationWithCache(innertube, urlChannel, config);
    expect(resChannel2).toEqual(resChannel1);

    // Validate calls order includes get/set interactions
    expect(calls.some(c => c.fn === 'get' && c.key === `yt:navigation:watch:${urlWatch}`)).toBe(true);
    expect(calls.some(c => c.fn === 'set' && c.key === `yt:navigation:watch:${urlWatch}` && c.ttl === 300)).toBe(true);
    expect(calls.some(c => c.fn === 'get' && c.key === `yt:navigation:channel:${urlChannel}`)).toBe(true);
    expect(calls.some(c => c.fn === 'set' && c.key === `yt:navigation:channel:${urlChannel}` && c.ttl === 600)).toBe(true);
  });
});
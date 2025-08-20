import type { YTNodes } from 'youtubei.js';

export type NavigationError = {
  __error: true;
  message: string;
  code: string;
  status: number;
};

export type NavigationMapValue = YTNodes.NavigationEndpoint | NavigationError;

export type ChannelDto = Record<string, unknown>; // refine if you have a DTO type

export type ChannelBatchItem = ChannelDto | { error: string; code: string };
export type ChannelBatchResponse = Record<string, ChannelBatchItem>;

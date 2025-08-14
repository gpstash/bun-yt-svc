import { createLogger } from "@/lib/logger.lib";
import { ClientType, Innertube, UniversalCache, YT } from "youtubei.js";
import { generatePoToken } from "@/lib/pot.lib";
import { parseVideoInfo, ParsedVideoInfo } from "@/helper/video.helper";

const logger = createLogger('service:InnertubeService');


export interface CreateInnertubeOptions {
  withPlayer?: boolean;
  location?: string;
  safetyMode?: boolean;
  clientType?: ClientType;
  generateSessionLocally?: boolean;
}

export class InnertubeService {
  public async getVideoInfo(id: string, parse: boolean): Promise<YT.VideoInfo | ParsedVideoInfo> {
    let contentPoToken, sessionPoToken;
    const webInnertube = await this.createInnertube({ withPlayer: true, generateSessionLocally: false });
    let clientName = webInnertube.session.context.client.clientName;

    ({ contentPoToken, sessionPoToken } = await generatePoToken(id, webInnertube.session.context.client.visitorData!))
    const info: YT.VideoInfo = await webInnertube.getInfo(id, { po_token: contentPoToken });

    // temporary workaround for SABR-only responses
    const mwebInfo = await webInnertube.getBasicInfo(id, { client: 'MWEB', po_token: contentPoToken })

    if (mwebInfo?.playability_status?.status === 'OK' && mwebInfo?.streaming_data) {
      info.playability_status = mwebInfo.playability_status
      info.streaming_data = mwebInfo.streaming_data

      clientName = 'MWEB'
    }

    let hasTrailer = info.has_trailer
    let trailerIsAgeRestricted = info.getTrailerInfo() === null

    if (
      ((info?.playability_status?.status === 'UNPLAYABLE' || info?.playability_status?.status === 'LOGIN_REQUIRED') &&
        info?.playability_status?.reason === 'Sign in to confirm your age') ||
      (hasTrailer && trailerIsAgeRestricted)
    ) {
      const webEmbeddedInnertube = await this.createInnertube({ clientType: ClientType.WEB_EMBEDDED })
      webEmbeddedInnertube.session.context.client.visitorData = webInnertube.session.context.client.visitorData

      const videoId = hasTrailer && trailerIsAgeRestricted ? (info?.playability_status?.error_screen as any)?.video_id : id

      // getBasicInfo needs the signature timestamp (sts) from inside the player
      webEmbeddedInnertube.session.player = webInnertube.session.player

      const bypassedInfo = await webEmbeddedInnertube.getBasicInfo(videoId, { client: 'WEB_EMBEDDED', po_token: contentPoToken })

      if (bypassedInfo?.playability_status?.status === 'OK' && bypassedInfo?.streaming_data) {
        info.playability_status = bypassedInfo.playability_status
        info.streaming_data = bypassedInfo.streaming_data
        info.basic_info.start_timestamp = bypassedInfo.basic_info.start_timestamp
        info.basic_info.duration = bypassedInfo.basic_info.duration
        info.captions = bypassedInfo.captions
        info.storyboards = bypassedInfo.storyboards

        hasTrailer = false
        trailerIsAgeRestricted = false

        clientName = webEmbeddedInnertube.session.context.client.clientName
      }
    }

    if ((info?.playability_status?.status === 'UNPLAYABLE' && (!hasTrailer || trailerIsAgeRestricted)) ||
      info?.playability_status?.status === 'LOGIN_REQUIRED') {
      return parse ? parseVideoInfo(info) : info
    }

    if (hasTrailer && info?.playability_status?.status !== 'OK') {
      const trailerInfo = info.getTrailerInfo()

      // don't override the timestamp of when the video will premiere for upcoming videos
      if (info.basic_info.start_timestamp && info?.playability_status?.status !== 'LIVE_STREAM_OFFLINE') {
        // trailerInfo?.basic_info.start_timestamp can be undefined; coalesce to null to match type Date | null
        info.basic_info.start_timestamp = trailerInfo?.basic_info.start_timestamp ?? null
      }

      info.playability_status = trailerInfo?.playability_status
      info.streaming_data = trailerInfo?.streaming_data
      info.basic_info.duration = trailerInfo?.basic_info.duration
      info.captions = trailerInfo?.captions
      info.storyboards = trailerInfo?.storyboards
    }

    if (info.streaming_data) {
      if (info.streaming_data.dash_manifest_url) {
        let url = info.streaming_data.dash_manifest_url

        if (url.includes('?')) {
          url += `&pot=${encodeURIComponent(sessionPoToken)}&mpd_version=7`
        } else {
          url += `${url.endsWith('/') ? '' : '/'}pot/${encodeURIComponent(sessionPoToken)}/mpd_version/7`
        }

        info.streaming_data.dash_manifest_url = url
      }
    }

    if (info.captions?.caption_tracks) {
      for (const captionTrack of info.captions.caption_tracks) {
        const url = new URL(captionTrack.base_url)

        url.searchParams.set('potc', '1')
        url.searchParams.set('pot', contentPoToken)
        url.searchParams.set('c', clientName)
        url.searchParams.set('fmt', 'json3');

        // Remove &xosf=1 as it adds `position:63% line:0%` to the subtitle lines
        // placing them in the top right corner
        url.searchParams.delete('xosf');

        captionTrack.base_url = url.toString()
      }
    }

    return parse ? parseVideoInfo(info) : info
  }

  public static instance: InnertubeService;
  public static getInstance(): InnertubeService {
    logger.debug('Get instance');
    if (!this.instance) {
      this.instance = new InnertubeService();
      logger.debug('No instance found, create new instance');
    }
    logger.debug('Return instance');
    return this.instance;
  }

  public async createInnertube(opts?: CreateInnertubeOptions): Promise<Innertube> {
    const { withPlayer, location, safetyMode, clientType, generateSessionLocally } = {
      withPlayer: false,
      safetyMode: false,
      generateSessionLocally: false,
      ...opts,
    };

    let cache;
    if (withPlayer) cache = new UniversalCache(false);
    return await Innertube.create({
      // This setting is enabled by default and results in YouTube.js reusing the same session across different Innertube instances.
      // That behavior is highly undesirable for FreeTube, as we want to create a new session every time to limit tracking.
      enable_session_cache: false,
      retrieve_innertube_config: !generateSessionLocally,
      user_agent: navigator.userAgent,

      retrieve_player: !!withPlayer,
      location: location,
      enable_safety_mode: !!safetyMode,
      client_type: clientType,
      cache,
      generate_session_locally: !!generateSessionLocally
    });
  }
}

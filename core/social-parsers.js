import fetch from 'node-fetch';
import TwitterLite from 'twitter-lite';
import { createClient } from 'tumblr.js';
import YTDlpWrap from 'yt-dlp-wrap';
import { parse as parseHTML } from 'node-html-parser';
import VideoAudioMerge from '../util/video-audio-merge.js';
import { SafeParseURL, ParseQuery, ParsePath } from '../util/urls.js';
import LogMessageOrError from '../util/log.js';
import { LoadTokensConfig } from '../util/load-configs.js';
import UgoiraBuilder from '../util/ugoira-builder.js';
import FormViewerURL from '../util/form-viewer-url.js';

const { TWITTER_OAUTH, INSTAGRAM_COOKIE, TUMBLR_OAUTH, JOYREACTOR_COOKIE } = LoadTokensConfig();

const DEFAULT_HEADERS = {
  accept:
    // eslint-disable-next-line max-len
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  'accept-language': 'en-US,en;q=0.9,ru-RU;q=0.8,ru;q=0.7',
  'cache-control': 'max-age=0',
  'sec-ch-ua': '"Google Chrome";v="107", "Chromium";v="107", "Not=A?Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

/**
 * https://developer.twitter.com/en/portal/dashboard
 * https://developer.twitter.com/en/docs/authentication/oauth-1-0a/obtaining-user-access-tokens
 *
 * App Key === API Key === Consumer API Key === Consumer Key === Customer Key === oauth_consumer_key
 * App Key Secret === API Secret Key === Consumer Secret === Consumer Key === Customer Key === oauth_consumer_secret
 * Access token === Token === resulting oauth_token
 * Access token secret === Token Secret === resulting oauth_token_secret
 */
/** @type {import("twitter-lite").TwitterOptions} */
const TWITTER_CLIENT_CONFIG = {
  version: '2',
  extension: false,
  consumer_key: TWITTER_OAUTH.consumer_key,
  consumer_secret: TWITTER_OAUTH.consumer_secret,
  access_token_key: TWITTER_OAUTH.access_token_key,
  access_token_secret: TWITTER_OAUTH.access_token_secret,
};

/** @type {import("twitter-lite").default} */
const TwitterClient = new TwitterLite(TWITTER_CLIENT_CONFIG);

const TumblrClient = createClient({
  credentials: TUMBLR_OAUTH,
  returnPromises: true,
});

/** @type {import("yt-dlp-wrap").default} */
// eslint-disable-next-line new-cap
const youtubeClient = new YTDlpWrap.default();

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Twitter = (url) => {
  const statusID = url.pathname.match(/^(?:\/[\w_]+)?\/status(?:es)?\/(\d+)/)?.[1];
  if (!statusID) return Promise.resolve({});

  /**
   * https://developer.twitter.com/en/docs/twitter-api/migrate/twitter-api-endpoint-map
   * https://developer.twitter.com/en/docs/twitter-api/tweets/lookup/api-reference/get-tweets-id
   */
  return TwitterClient.get(`tweets/${statusID}`, {
    expansions: ['author_id', 'attachments.media_keys'].join(','),
    'tweet.fields': ['text', 'entities'].join(','),
    'user.fields': ['id', 'name', 'username'].join(','),
    'media.fields': ['media_key', 'type', 'url', 'width', 'height', 'variants'].join(','),
  }).then(
    /** @param {import("../types/twitter-v2").TwitterV2} twitterResponse */ (twitterResponse) => {
      const tweetId = twitterResponse.data?.id;
      if (!tweetId) return Promise.reject(new Error(`No tweet ID in twitterResponse`));

      const trimmedText = (twitterResponse.data.text || '')
        .replace(/\s?(?:https?:\/\/)?t.co\/\w+$/gi, '')
        .replace(/\s+/gi, ' ')
        .trim();

      const caption = twitterResponse.data.entities?.urls?.length
        ? twitterResponse.data.entities.urls
            .reduce(
              (accumText, urlEntity) =>
                accumText.replace(
                  urlEntity.url,
                  SafeParseURL(urlEntity.expanded_url).pathname.includes(`status/${tweetId}`)
                    ? ''
                    : urlEntity.expanded_url
                ),
              trimmedText
            )
            .replace(/\s+/gi, ' ')
            .trim()
        : trimmedText;

      const user = (twitterResponse.includes?.users || []).find(
        (includedUser) => includedUser.id === twitterResponse.data.author_id
      );

      /** @type {import("../types/social-post").SocialPost} */
      const socialPost = {
        caption,
        author: user?.name,
        authorURL: `https://twitter.com/${user?.username}`,
        postURL: `https://twitter.com/${user?.username}/status/${tweetId}`,
        medias: (twitterResponse.includes?.media || [])
          .filter((tweetMedium) => twitterResponse.data.attachments?.media_keys?.includes(tweetMedium.media_key))
          .map(
            /** @returns {import("../types/social-post").Media */ (tweetMedium) => {
              if (tweetMedium.type === 'photo')
                return {
                  type: 'photo',
                  externalUrl: tweetMedium.url,
                  original: `${tweetMedium.url}:orig`,
                  description: `${tweetMedium.width}x${tweetMedium.height}`,
                };

              if (tweetMedium.type === 'video' || tweetMedium.type === 'animated_gif') {
                const bestVariant = tweetMedium.variants
                  .filter((variant) => 'bit_rate' in variant || tweetMedium.type === 'animated_gif')
                  .sort((prev, next) => prev.bit_rate - next.bit_rate)
                  .pop();

                if (!bestVariant?.url) return null;
                return {
                  type: tweetMedium.type === 'animated_gif' ? 'gif' : 'video',
                  externalUrl: bestVariant.url,
                  original: bestVariant.url,
                  description: `${tweetMedium.width}x${tweetMedium.height}`,
                };
              }

              return null;
            }
          )
          .filter(Boolean),
      };

      return Promise.resolve(socialPost);
    }
  );
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const TwitterDirect = (url) => {
  if (url.hostname === 'video.twimg.com') {
    url.search = '';

    return Promise.resolve({
      author: '',
      authorURL: '',
      caption: '',
      postURL: url.href,
      medias: [
        {
          type: 'video',
          externalUrl: url.href,
          original: url.href,
        },
      ],
    });
  }

  const format = ParseQuery(url.query)?.format || 'jpg';
  const mediaPathname = url.pathname.replace(/:\w+$/, '').replace(/\.\w+$/, '');

  return Promise.resolve({
    author: '',
    authorURL: '',
    caption: '',
    postURL: `https://pbs.twimg.com${mediaPathname}.${format}`,
    medias: [
      {
        type: 'photo',
        externalUrl: `https://pbs.twimg.com${mediaPathname}.${format}`,
        original: `https://pbs.twimg.com${mediaPathname}.${format}:orig`,
      },
    ],
  });
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Instagram = (url) => {
  const PATH_REGEXP = /^\/p\/([\w-]+)(\/)?$/i;
  if (!PATH_REGEXP.test(url.pathname)) return Promise.resolve({});

  return fetch(`https://${url.hostname}${url.pathname}?__a=1&__d=dis`, {
    headers: {
      ...DEFAULT_HEADERS,
      referer: 'https://www.instagram.com/',
      cookie: INSTAGRAM_COOKIE,
    },
    referrerPolicy: 'strict-origin-when-cross-origin',
    body: null,
    method: 'GET',
    mode: 'cors',
  })
    .then((res) => {
      if (res.ok) return res.json();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((graphData) => {
      const post = graphData?.items?.[0];

      if (!post) return Promise.reject(new Error(`No post in... post: https://${url.hostname}${url.pathname}`));

      /** @type {import("../types/social-post").SocialPost} */
      const socialPost = {
        caption: post?.caption?.text || '',
        postURL: `https://instagram.com${url.pathname}`,
        author: post?.user?.username,
        authorURL: `https://instagram.com/${post?.user?.username}`,
      };

      const singleVideo = post.video_versions;
      const singleImage = post.image_versions2?.candidates;
      const multipleMedia = post.carousel_media;

      if (singleVideo) {
        socialPost.medias = [
          {
            type: 'video',
            externalUrl: singleVideo.sort((prev, next) => next.width - prev.width)?.[0]?.url,
          },
        ];
      } else if (singleImage) {
        socialPost.medias = [
          {
            type: 'photo',
            externalUrl: singleImage.sort((prev, next) => next.width - prev.width)?.[0]?.url,
          },
        ];
      } else if (multipleMedia) {
        socialPost.medias = multipleMedia
          .map(
            /** @returns {import("../types/social-post").Media} */ (media) => {
              if (!media) return null;

              if (media.video_versions)
                return {
                  type: 'video',
                  externalUrl: media.video_versions?.pop()?.url,
                };

              const candidates = media?.image_versions2?.candidates;

              return {
                type: 'photo',
                externalUrl: candidates.sort((prev, next) => next.width - prev.width)?.[0]?.url,
              };
            }
          )
          .filter(Boolean);
      }

      return Promise.resolve(socialPost);
    });
};

/**
 * @param {URL} url
 * @param {number} [certainImageIndex] Unique parameter only for parser `PixivDirect`
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Pixiv = (url, certainImageIndex) => {
  const PIXIV_PAGE_RX = /^\/(?:\w{2}\/)?artworks\/(?<illustId>\d+)/i;
  const PIXIV_HEADERS = {
    ...DEFAULT_HEADERS,
    referer: 'https://www.pixiv.net/',
  };

  const pageMatch = url.pathname.match(PIXIV_PAGE_RX);
  /** @type {string} */
  const illustId = pageMatch?.groups?.illustId || ParseQuery(url.search).illust_id;
  if (!illustId) return Promise.resolve({});

  const postURL = `https://www.pixiv.net/en/artworks/${illustId}`;

  return fetch(postURL, { headers: PIXIV_HEADERS })
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((pixivPage) => {
      try {
        const parsedHTML = parseHTML(pixivPage);

        const metaPreloadData = parsedHTML.getElementById('meta-preload-data');
        if (!metaPreloadData) throw new Error('No <metaPreloadData> in <pixivPage>');

        const preloadContentRaw = metaPreloadData.getAttribute('content');
        if (!preloadContentRaw) throw new Error('No <preloadContent> in <metaPreloadData>');

        const preloadContentParsed = JSON.parse(preloadContentRaw);
        return Promise.resolve(preloadContentParsed);
      } catch (e) {
        return Promise.reject(e);
      }
    })
    .then(
      /** @param {import("../types/pixiv-preload").PixivPreload} pixivPreload */ (pixivPreload) => {
        const post = pixivPreload?.illust?.[illustId];
        if (!post) return Promise.reject(new Error(`No <post> in preloadContent: ${postURL}`));

        /** @type {import("../types/social-post").SocialPost} */
        const socialPost = {
          caption: post.title || post.illustTitle || post.description || post.illustComment,
          author: post.userName,
          authorURL: `https://www.pixiv.net/en/users/${post.userId}`,
          postURL,
          medias: [],
        };

        /**
         * Aka GIF stored as jpg/png in zip
         * @type {boolean}
         */
        const isUgoira =
          Object.keys(post.urls || {})
            .map((key) => post.urls[key] || '')
            .some((firstImgUrl) => typeof firstImgUrl === 'string' && /ugoira/i.test(firstImgUrl)) ||
          post.tags?.tags?.some((tag) => /ugoira/i.test(tag.romaji));

        if (isUgoira) {
          const ugoiraMetaUrl = `https://www.pixiv.net/ajax/illust/${illustId}/ugoira_meta`;

          return fetch(ugoiraMetaUrl, { headers: PIXIV_HEADERS })
            .then((res) => {
              if (res.ok) return res.json();
              return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
            })
            .then(
              /** @param {import('../types/pixiv-ugoira-meta').UgoiraMeta} ugoiraMeta */ (ugoiraMeta) => {
                const uroiraOriginalZip = ugoiraMeta.body.originalSrc;
                return fetch(uroiraOriginalZip, { headers: PIXIV_HEADERS })
                  .then((res) => {
                    if (res.ok) return res.arrayBuffer();
                    return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
                  })
                  .then((ugoiraSourceZip) => UgoiraBuilder(ugoiraMeta, ugoiraSourceZip))
                  .then((ugoiraBuilt) => {
                    socialPost.medias.push({ ...ugoiraBuilt });
                    return Promise.resolve(socialPost);
                  });
              }
            );
        }

        const sourcesAmount = post?.pageCount;

        for (let i = 0; i < sourcesAmount; i++) {
          const origFilename = post.urls.original;
          const origBasename = origFilename.replace(/\d+\.(\w+)$/i, '');
          let origFiletype = origFilename.match(/\.(\w+)$/i);

          // eslint-disable-next-line prefer-destructuring
          if (origFiletype && origFiletype[1]) origFiletype = origFiletype[1];
          else origFiletype = 'png';

          const masterFilename = post.urls.regular;

          if (!(typeof certainImageIndex === 'number' && certainImageIndex !== i))
            socialPost.medias.push({
              type: 'photo',
              externalUrl: FormViewerURL(
                masterFilename.replace(/\d+(_master\d+\.\w+$)/i, `${i}$1`),
                'https://www.pixiv.net/'
              ),
              original: FormViewerURL(`${origBasename + i}.${origFiletype}`, 'https://www.pixiv.net/'),
            });
        }

        return Promise.resolve(socialPost);
      }
    );
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const PixivDirect = (url) => {
  const PIXIV_IMAGE_RX = /\/(?<illustId>\d+)_p(?<imageIndex>\d+)(?:_\w+)?\.\w+$/;
  const imageMatch = url.pathname.match(PIXIV_IMAGE_RX);
  if (!Object.keys(imageMatch?.groups || {}).length) {
    LogMessageOrError(new Error(`Bad Pixiv image url: ${url.href}`));
    return Promise.resolve({});
  }

  const { illustId, imageIndex } = imageMatch.groups;
  if (!illustId || typeof parseInt(imageIndex) !== 'number') {
    LogMessageOrError(new Error(`Bad Pixiv image url: ${url.href}`));
    return Promise.resolve({});
  }

  const pixivUrl = new URL(`https://www.pixiv.net/en/artworks/${illustId}`);
  return Pixiv(pixivUrl, parseInt(imageIndex));
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Reddit = (url) => {
  if (!url.pathname) return Promise.resolve({});

  const REDDIT_POST_REGEXP = /^(?<givenPathname>(?:\/r\/[\w-._]+)?\/comments\/[\w-.]+)(?:\/)?/i;
  const REDDIT_HEADERS = {
    ...DEFAULT_HEADERS,
    referer: 'https://www.reddit.com/',
  };

  const match = (url.hostname === 'redd.it' ? `/comments${url.pathname}` : url.pathname).match(REDDIT_POST_REGEXP);
  const givenPathname = match?.groups?.givenPathname;
  if (!givenPathname) return Promise.resolve({});

  const postURL = new URL(givenPathname, 'https://www.reddit.com').href;

  return fetch(`${postURL}.json`, { headers: REDDIT_HEADERS })
    .then((res) => {
      if (res.ok) return res.json();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then(
      /** @param {import('../types/reddit-post').RedditPost} redditPostJSON */ (redditPostJSON) => {
        const post = redditPostJSON[0]?.data?.children?.[0]?.data;
        if (!post) return Promise.reject(new Error('No <post> in <redditPost>'));

        const caption = post.title || '';
        const author = post.author || '';
        const authorURL = `https://www.reddit.com/u/${author}`;
        const imageURL = post.url || post.url_overridden_by_dest;
        const isImgur = /imgur\.com$/i.test(SafeParseURL(imageURL).hostname);
        const isGif = /\.gif$/i.test(imageURL);
        const isVideo = post.is_video;
        const isGallery = post.is_gallery;
        const crossPostParent = post.crosspost_parent;

        if (crossPostParent && typeof crossPostParent === 'string') {
          const parentId = crossPostParent.split('_')[1];
          if (!parentId) return Promise.resolve({});

          return Reddit(new URL(`/comments/${parentId}`, 'https://www.reddit.com'));
        }

        if (isVideo) {
          const video = post.secure_media?.reddit_video?.fallback_url;
          if (!video) return Promise.reject(new Error('Reddit no video'));

          const hslPlaylist = post.secure_media?.reddit_video?.hls_url;
          if (isGif || !hslPlaylist) return Promise.resolve({ externalUrl: video });

          return fetch(hslPlaylist, {
            headers: {
              ...REDDIT_HEADERS,
              host: SafeParseURL(hslPlaylist).hostname,
            },
          })
            .then((res) => {
              if (res.ok) return res.text();
              return Promise.reject(new Error(`Response status from Reddit ${res.status}`));
            })
            .then((hslFile) => {
              const hslPlaylistLines = hslFile.split('\t');
              const audioPlaylistLocation =
                (hslPlaylistLines.filter((line) => /TYPE=AUDIO/i.test(line)).pop() || '').match(/URI="([^"]+)"/)?.[1] ||
                '';

              return fetch(hslPlaylist.replace(/\/[^/]+$/, `/${audioPlaylistLocation}`), {
                headers: {
                  ...REDDIT_HEADERS,
                  host: SafeParseURL(hslPlaylist).hostname,
                },
              });
            })
            .then((res) => {
              if (res.ok) return res.text();
              return Promise.reject(new Error(`Response status from Reddit ${res.status}`));
            })
            .then((audioPlaylistFile) => {
              const audioFilename = (
                audioPlaylistFile
                  .split('\n')
                  .filter((line) => line && !/^#/.test(line))
                  .pop() || ''
              ).trim();
              if (!audioFilename) return Promise.resolve({ externalUrl: video });

              const audio = hslPlaylist.replace(/\/[^/]+$/, `/${audioFilename}`);
              if (!audio) return Promise.resolve({ externalUrl: video });

              return VideoAudioMerge(video, audio).catch(() => Promise.resolve({ externalUrl: video }));
            })
            .catch(() => Promise.resolve({ externalUrl: video }))
            .then((videoResult) => {
              /** @type {import("../types/social-post").Media[]} */
              const videoSources = [];

              if ('externalUrl' in videoResult)
                videoSources.push({
                  externalUrl: videoResult.externalUrl,
                  type: isGif ? 'gif' : 'video',
                });
              else if ('filename' in videoResult)
                videoSources.push({
                  type: 'video',
                  otherSources: {
                    audioSource: videoResult.audioSource,
                    videoSource: videoResult.videoSource,
                  },
                  filename: videoResult.filename,
                  filetype: SafeParseURL(videoResult.videoSource).pathname.split('.').pop(),
                  fileCallback: videoResult.fileCallback,
                });

              return Promise.resolve({
                author,
                authorURL,
                postURL,
                caption,
                medias: videoSources,
              });
            });
        }

        if (isGallery)
          return Promise.resolve({
            author,
            authorURL,
            postURL,
            caption,
            medias: (post.gallery_data?.items || [])
              .map(
                /** @returns {import("../types/social-post").Media} */ (item) => {
                  const source = post.media_metadata?.[item.media_id]?.s;
                  if (!source) return null;

                  if (source.gif)
                    return {
                      type: 'gif',
                      externalUrl: source.gif,
                    };

                  try {
                    const previewUrl = SafeParseURL(source.u);

                    return {
                      type: 'photo',
                      externalUrl: `https://${previewUrl.hostname.replace(/^preview\./i, 'i.')}${previewUrl.pathname}`,
                    };
                  } catch (e) {
                    return null;
                  }
                }
              )
              .filter(Boolean),
          });

        /** @type {import('../types/social-post').Media[]} */
        const previewMedia = (post.preview?.images || [])
          .map(
            /** @returns {import('../types/social-post').Media} */ (image) => {
              if (!image?.variants) return null;

              const isGifByPresentVariant = image.variants.gif?.source?.url;
              const videoUrl = (image.variants.mp4?.source?.url || '').replace(/&amp;/g, '&');

              if (!videoUrl) return null;

              return {
                type: isGifByPresentVariant ? 'gif' : 'video',
                externalUrl: videoUrl,
                filetype: 'mp4',
              };
            }
          )
          .filter(Boolean);

        return Promise.resolve({
          author,
          authorURL,
          postURL,
          caption,
          medias: previewMedia.length
            ? previewMedia
            : imageURL
            ? [
                {
                  type: isGif ? 'gif' : 'photo',
                  externalUrl: isImgur
                    ? (post.preview?.images?.[0]?.source?.url || '').replace(/&amp;/g, '&') || imageURL
                    : imageURL,
                },
              ]
            : [],
        });
      }
    );
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Tumblr = (url) => {
  const blogID = url.hostname.replace(/\.tumblr\.(com|co\.\w+|org)$/i, '');
  const postID = url.pathname.match(/^\/posts?\/(\d+)/i)?.[1];

  if (!blogID || !postID) return Promise.resolve({});

  const API_PATH_BASE = `/v2/blog/__BLOG_ID__/posts/__POST_ID__`;
  const fetchingAPIPath = API_PATH_BASE.replace(/__BLOG_ID__/g, blogID).replace(/__POST_ID__/g, postID);

  return TumblrClient.getRequest(fetchingAPIPath, {}).then(
    /** @param {import("../types/tumblr").Tumblr} tumblr */ (tumblr) => {
      const content = tumblr.content?.length ? tumblr.content : tumblr.trail?.[0]?.content;
      if (!content) return Promise.reject(new Error(`No content in tumblr: ${url.pathname}`));

      /** @type {import("../types/social-post").Media[]} */
      const medias = content
        .filter((block) => block.type === 'image')
        .map((image) => {
          if (!image.media) return null;

          return image.media.sort((prev, next) => next.width - prev.width)?.[0];
        })
        .filter(Boolean)
        .map((image) => ({
          type: 'photo',
          externalUrl: image.url,
        }));

      if (!medias?.length) return Promise.reject(new Error(`No medias in tumblr: ${url.pathname}`));

      const caption = content
        .filter((block) => block.type === 'text')
        .map((text) => text?.text || '')
        .join('\n\n');

      /** @type {import("../types/social-post").SocialPost} */
      const fineTumblrSocialPost = {
        author: blogID,
        authorURL: `https://${blogID}.tumblr.com`,
        caption: caption || '',
        medias,
        postURL: `https://${blogID}.tumblr.com/post/${postID}`,
      };

      return Promise.resolve(fineTumblrSocialPost);
    }
  );
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Danbooru = (url) => {
  if (!/^\/posts\/\d+/.test(url.pathname)) return Promise.resolve({});

  return fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((danbooruPage) => {
      /** @type {import("../types/social-post").SocialPost} */
      const socialPost = {
        author: '',
        authorURL: '',
        caption: '',
        postURL: url.href,
      };

      try {
        const parsedHTML = parseHTML(danbooruPage);

        const sizeAnchor = parsedHTML.querySelector('#post-info-size > a');
        if (!sizeAnchor) return Promise.reject(new Error('Danbooru no <sizeAnchor>'));

        const pictureURL = sizeAnchor.getAttribute('href');

        socialPost.medias = [
          {
            type: 'photo',
            externalUrl: pictureURL,
          },
        ];

        const uploaderAnchor = parsedHTML.querySelector('#post-info-uploader > a');
        if (uploaderAnchor) {
          socialPost.author = uploaderAnchor.getAttribute('data-user-name') || '';
          socialPost.authorURL = new URL(uploaderAnchor.getAttribute('href') || '', url.origin);
        }

        return Promise.resolve(socialPost);
      } catch (e) {
        return Promise.reject(e);
      }
    });
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Gelbooru = (url) =>
  fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((gelbooruPage) => {
      try {
        const parsedHTML = parseHTML(gelbooruPage);

        const tagList = parsedHTML.querySelector('.tag-list');
        if (!tagList) throw new Error('No <tagList> in <gelbooruPage>');

        const originalLink = tagList.querySelector(`a[href$=".jpeg"], a[href$=".jpg"], a[href$=".png"]`);
        if (!originalLink) throw new Error('No <originalLink> in <tagList>');

        const source = originalLink.getAttribute('href');
        if (!source) throw new Error('No <source> in <originalLink>');

        return Promise.resolve({
          author: '',
          authorURL: '',
          postURL: url.href,
          caption: '',
          medias: [
            {
              type: 'photo',
              externalUrl: source,
            },
          ],
        });
      } catch (e) {
        return Promise.reject(e);
      }
    });

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Konachan = (url) =>
  fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((konachanPage) => {
      let source = '';

      try {
        source = konachanPage.split('<body')[1].match(
          // eslint-disable-next-line max-len
          /<a(\s+[\w-]+="([^"]+)")*\s+href="([^"]+)"(\s+[\w-]+="([^"]+)")*\s+id="highres"(\s+[\w-]+="([^"]+)")*/i
        );

        // eslint-disable-next-line prefer-destructuring
        if (source) source = source[3];
      } catch (e) {
        return Promise.reject(new Error(['Error on parsing Konachan', url.href, e]));
      }

      if (!source) return Promise.reject(new Error(['No Konachan source', url.href]));

      return Promise.resolve({
        author: '',
        authorURL: '',
        postURL: url.href,
        caption: '',
        medias: [
          {
            type: 'photo',
            externalUrl: source,
          },
        ],
      });
    });

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Yandere = (url) =>
  fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((yanderePage) => {
      let source = '';

      try {
        source = yanderePage.split('<body')[1].match(/<a\s+class="[^"]+"\s+id="highres"\s+href="([^"]+)"/i);

        // eslint-disable-next-line prefer-destructuring
        if (source) source = source[1];
      } catch (e) {
        return Promise.reject(new Error(['Error on parsing Yandere', url.href, e]));
      }

      if (!source) return Promise.reject(new Error(['No Yandere source', url.href]));

      return Promise.resolve({
        author: '',
        authorURL: '',
        postURL: url.href,
        caption: '',
        medias: [
          {
            type: 'photo',
            externalUrl: source,
          },
        ],
      });
    });

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Eshuushuu = (url) =>
  fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((eshuushuuPage) => {
      let source = '';

      try {
        source = eshuushuuPage.split('<body')[1].match(/<a\s+class="thumb_image"\s+href="([^"]+)"/i);

        if (source && source[1])
          source = `https://e-shuushuu.net/${source[1].replace(/\/\//g, '/').replace(/^\//g, '')}`;
      } catch (e) {
        return Promise.reject(new Error(['Error on parsing Eshuushuu', url.href, e]));
      }

      if (!source) return Promise.reject(new Error(['No Eshuushuu source', url.href]));

      return Promise.resolve({
        author: '',
        authorURL: '',
        postURL: url.href,
        caption: '',
        medias: [
          {
            type: 'photo',
            externalUrl: source,
          },
        ],
      });
    });

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Sankaku = (url) =>
  fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((sankakuPage) => {
      let source = '';

      try {
        source = sankakuPage.split('<body')[1].match(/<a\s+href="([^"]+)"\s+id=(")?highres/i);

        if (source && source[1]) source = source[1].replace(/&amp;/g, '&');
      } catch (e) {
        return Promise.reject(new Error(['Error on parsing Sankaku', url.href, e]));
      }

      if (!source) return Promise.reject(new Error(['No Sankaku source', url.href]));
      if (source.slice(0, 6) !== 'https:') source = `https:${source}`;

      return Promise.resolve({
        author: '',
        authorURL: '',
        postURL: url.href,
        caption: '',
        medias: [
          {
            type: 'photo',
            externalUrl: source,
          },
        ],
      });
    });

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Zerochan = (url) =>
  fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((zerochanPage) => {
      let source = '';

      try {
        source = zerochanPage.split('</head')[0].match(/<meta\s+(name|property)="og:image"\s+content="([^"]+)"/i);

        // eslint-disable-next-line prefer-destructuring
        if (source) source = source[2];

        if (!source) {
          source = zerochanPage
            .split('</head')[0]
            .match(/<meta\s+(name|property)="twitter:image"\s+content="([^"]+)"/i);

          // eslint-disable-next-line prefer-destructuring
          if (source) source = source[2];
        }
      } catch (e) {
        return Promise.reject(new Error(['Error on parsing Zerochan', url.href, e]));
      }

      if (!source) return Promise.reject(new Error(['No Zerochan source', url.href]));

      const sourceBasename = source.replace(/\.\w+$/, '');
      const basenameMatch = zerochanPage.match(new RegExp(`${sourceBasename}.[\\w\\d]+`, 'gi'));

      if (basenameMatch && basenameMatch.pop) source = basenameMatch.pop();

      return Promise.resolve({
        author: '',
        authorURL: '',
        postURL: url.href,
        caption: '',
        medias: [
          {
            type: 'photo',
            externalUrl: source,
          },
        ],
      });
    });

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const AnimePictures = (url) =>
  fetch(url.href)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((animePicturesPage) => {
      try {
        const parsedHTML = parseHTML(animePicturesPage);

        const link = parsedHTML.getElementById('get_image_link');
        if (!link) throw new Error('No <link> in <parsedHTML>');

        const source = link.getAttribute('href');
        if (!source) throw new Error('No <source> in <link>');

        return Promise.resolve({
          author: '',
          authorURL: '',
          postURL: url.href,
          caption: '',
          medias: [
            {
              type: 'photo',
              externalUrl: new URL(source, url.origin).href,
            },
          ],
        });
      } catch (e) {
        return Promise.reject(e);
      }
    });

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const KemonoParty = (url) => {
  if (!url.pathname) return Promise.resolve({});

  const postURL = `https://kemono.party${url.pathname}`;

  return fetch(postURL)
    .then((res) => {
      if (res.ok) return res.text();
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then((kemonoPartyPage) => {
      /** @type {import("../types/social-post").SocialPost} */
      const socialPost = {
        author: '',
        authorURL: '',
        caption: '',
        postURL: url.href,
        medias: [],
      };

      try {
        const parsedHTML = parseHTML(kemonoPartyPage);
        const filesAnchors = parsedHTML.querySelectorAll('.post__thumbnail > .fileThumb');

        if (!(filesAnchors instanceof Array)) throw new Error('No array with files');

        filesAnchors.slice(1).forEach((fileAnchor) => {
          /** @type {import("../types/social-post").Media} */
          const media = {
            type: 'photo',
          };

          const fullsizeURL = fileAnchor.getAttribute('href');
          if (fullsizeURL) media.original = new URL(fullsizeURL, url.origin);

          const thumbnailImage = fileAnchor.querySelector('img');
          if (thumbnailImage) media.externalUrl = new URL(thumbnailImage.getAttribute('src'), url.origin);

          socialPost.medias.push(media);
        });

        const usernameAnchor = parsedHTML.querySelector('.post__user-name');
        if (usernameAnchor) {
          socialPost.author = usernameAnchor.innerText?.trim() || '';
          socialPost.authorURL = new URL(usernameAnchor.getAttribute('href'), url.origin);
        }

        const postTitleHeader = parsedHTML.querySelector('.post__title');
        if (postTitleHeader) socialPost.caption = postTitleHeader.innerText?.trim() || '';

        return Promise.resolve(socialPost);
      } catch (error) {
        return Promise.reject(error);
      }
    });
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Youtube = (url) => {
  const queries = ParseQuery(url.search);
  const path = ParsePath(url.pathname);

  const brevityDomainId = /youtu\.be/gi.test(url.hostname) && path[0];
  const shortsId = /youtube\.com/gi.test(url.hostname) && path[0] === 'shorts' && path[1];
  const regularId = /youtube\.com/gi.test(url.hostname) && path[0] === 'watch' && queries?.v;

  if (!brevityDomainId && !shortsId && !regularId) {
    LogMessageOrError(`Bad Youtube video link: ${url.href}`);
    return Promise.resolve({});
  }

  const youtubeLink = `https://www.youtube.com/watch?v=${brevityDomainId || shortsId || regularId}`;

  return youtubeClient
    .execPromise([youtubeLink, '--dump-json'])
    .then(
      (youtubeOut) =>
        new Promise((resolve, reject) => {
          try {
            const parsedYoutubePage = JSON.parse(youtubeOut);
            resolve(parsedYoutubePage);
          } catch (e) {
            reject(e);
          }
        })
    )
    .then(
      /** @param {import("../types/youtube-video").YoutubeVideo} youtubeVideoOutput */ (youtubeVideoOutput) => {
        /** @type {import("../types/social-post").SocialPost} */
        const socialPost = {
          author: youtubeVideoOutput.uploader,
          authorURL: youtubeVideoOutput.uploader_url,
          caption:
            youtubeVideoOutput.title +
            (youtubeVideoOutput.description?.length < 50 ? youtubeVideoOutput.description : ''),
          postURL: youtubeVideoOutput.webpage_url,
          medias: [],
        };

        /**
         * @param {number} bytes
         * @returns {string}
         */
        const LocalHumanReadableSize = (bytes) => {
          const power = Math.floor(Math.log(bytes) / Math.log(1024));
          return `${(bytes / 1024 ** power).toFixed(2)} ${['B', 'kB', 'MB', 'GB', 'TB'][power]}`;
        };

        if (!youtubeVideoOutput.formats) return Promise.resolve(socialPost);

        const sortedFormats = youtubeVideoOutput.formats.sort((prev, next) => prev.height - next.height);

        sortedFormats.forEach((format) => {
          if (
            (!format.vcodec || format.vcodec === 'none') &&
            typeof format.acodec === 'string' &&
            format.acodec !== 'none'
          )
            socialPost.medias.push({
              type: 'audio',
              externalUrl: format.url,
              filesize: format.filesize,
              filetype: format.ext,
              description: `${format.format_note} / ${format.acodec.split('.')[0]} (${format.ext}) – audio${
                format.filesize ? ` / ${LocalHumanReadableSize(format.filesize)}` : ''
              }`,
            });
          else if (
            (!format.acodec || format.acodec === 'none') &&
            typeof format.vcodec === 'string' &&
            format.vcodec !== 'none'
          )
            socialPost.medias.push({
              type: 'video',
              externalUrl: format.url,
              filesize: format.filesize,
              filetype: format.ext,
              description: `${format.format_note} / ${format.vcodec.split('.')[0]} (${format.ext}) – video${
                format.filesize ? ` / ${LocalHumanReadableSize(format.filesize)}` : ''
              }`,
            });
          else if (
            typeof format.acodec === 'string' &&
            format.acodec !== 'none' &&
            typeof format.vcodec === 'string' &&
            format.vcodec !== 'none'
          )
            socialPost.medias.push({
              type: 'video',
              externalUrl: format.url,
              filesize: format.filesize,
              filetype: format.ext,
              description: `${format.format_note} / ${format.vcodec.split('.')[0]} + ${format.acodec.split('.')[0]} (${
                format.ext
              }) – video + audio${format.filesize ? ` / ${LocalHumanReadableSize(format.filesize)}` : ''}`,
            });
        });

        return Promise.resolve(socialPost);
      }
    );
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Osnova = (url) => {
  const siteHostname = url.hostname.replace(/^.*\.(\w+\.\w+)$/, '$1').replace('the.tj', 'tjournal.ru');

  const isUser = /^\/u/i.test(url.pathname);
  const postID = (
    isUser
      ? url.pathname.match(/^\/u\/\d+[\w-]+\/(?<postID>\d+)/)
      : url.pathname.match(/^(?:(?:\/s)?\/[\w-]+)?\/(?<postID>\d+)/)
  )?.groups?.postID;

  if (!postID) return Promise.resolve(null);

  return fetch(`https://api.${siteHostname}/v1.9/entry/${postID}`)
    .then((res) => {
      if (res.ok)
        return res.json().then((response) => {
          /** Osnova API post wrapped in `result` */
          if (response.result) return Promise.resolve(response.result);
          return Promise.reject(new Error('No <result> in Osnova API response'));
        });
      return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));
    })
    .then(
      /** @param {import("../types/osnova-post").OsnovaPost} osnovaPost */ (osnovaPost) => {
        /** @type {import("../types/social-post").SocialPost} */
        const socialPost = {
          author: osnovaPost.author.name,
          authorURL: osnovaPost.author.url,
          caption: osnovaPost.title || '',
          postURL: osnovaPost.url,
          medias: [],
        };

        /** @type {{ waiting: "Twitter" | "Instagram", link: string }[]} */
        const waitingExternalQueue = [];

        /**
         * @param {{ waiting: "Twitter" | "Instagram", link: string }} param0
         * @returns {Promise<import("../types/social-post").Media[]>}
         */
        const LocalLoadExternalBlock = ({ waiting, link }) => {
          if (waiting !== 'Twitter' && waiting !== 'Instagram') return Promise.resolve([]);

          return (waiting === 'Twitter' ? Twitter : Instagram)(SafeParseURL(link))
            .then((externalBlockPost) => {
              /** Block in Osnova post is corrupted */
              if (!(externalBlockPost?.medias instanceof Array)) return Promise.resolve([]);

              return Promise.resolve(externalBlockPost.medias);
            })
            .catch((e) => {
              LogMessageOrError(new Error(`Failed to load block data (${link}) inside Osnova post: ${e}`));
              return Promise.resolve([]);
            });
        };

        osnovaPost.blocks.forEach((block) => {
          if (block.type === 'tweet') {
            waitingExternalQueue.push({
              waiting: 'Twitter',
              // eslint-disable-next-line max-len
              link: `https://twitter.com/${block.data.tweet.data.tweet_data.user.screen_name}/status/${block.data.tweet.data.tweet_data.id_str}`,
            });
            return;
          }

          if (block.type === 'instagram') {
            waitingExternalQueue.push({
              waiting: 'Instagram',
              link: block.data.instagram.data.box_data.url,
            });
            return;
          }

          if (block.type === 'media' && block.data.items)
            block.data.items.forEach((media) => {
              if (!media.image) return;

              const isImage = media.image.data.type !== 'gif';
              const isWebp = media.image.data.type === 'webp';

              socialPost.medias.push({
                type: isImage ? 'photo' : 'video',
                externalUrl: `https://leonardo.osnova.io/${media.image.data.uuid}/${
                  isImage ? `-/preview/1000/${isWebp ? '-/format/jpeg/' : ''}` : '-/format/mp4/'
                }`,
                original: `https://leonardo.osnova.io/${media.image.data.uuid}`,
              });
            });
        });

        if (!waitingExternalQueue.length) return Promise.resolve(socialPost);

        return Promise.all(
          waitingExternalQueue.map((waitingExternalQueueBlock) => LocalLoadExternalBlock(waitingExternalQueueBlock))
        ).then((mediasFromExternalBlocks) => {
          socialPost.medias = socialPost.medias.concat(mediasFromExternalBlocks.flat());
          return Promise.resolve(socialPost);
        });
      }
    );
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Joyreactor = (url) => {
  const JOYREACTOR_DIRECT_HOSTNAME_RX = /^img\d+\./;
  if (JOYREACTOR_DIRECT_HOSTNAME_RX.test(url.hostname))
    return Promise.resolve({
      author: '',
      authorURL: '',
      caption: '',
      postURL: url.href,
      medias: [
        {
          type: /\.gif$/.test(url.pathname) ? 'gif' : 'photo',
          externalUrl: FormViewerURL(url.href, url.origin),
        },
      ],
    });

  const JOYREACTOR_POST_ID_RX = /^\/post\/(?<postID>\d+)/;
  const postID = url.pathname.match(JOYREACTOR_POST_ID_RX)?.groups?.postID;
  if (!postID) return Promise.resolve({});

  url.hostname = url.hostname.replace('m.', '');
  const postGettingUrl = `https://joyreactor.cc/post/${postID}`;

  /**
   * @param {string} imageLink
   * @returns {string}
   */
  const ReactorPrepareUrl = (imageLink) => {
    if (!imageLink || typeof imageLink !== 'string') return '';

    const preparing = SafeParseURL(imageLink);
    if (!preparing.pathname) return '';
    if (!preparing.protocol) preparing.protocol = 'https';
    return preparing.href;
  };

  return fetch(postGettingUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      referer: 'https://joyreactor.cc/',
      cookie: JOYREACTOR_COOKIE,
    },
  }).then((res) => {
    if (!res.ok) return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));

    return res.text().then((joyreactorPage) => {
      try {
        const parsedHTML = parseHTML(joyreactorPage);

        const postContent = parsedHTML.querySelector('.post_content');
        if (!postContent) throw new Error('No <postContent> in <joyreactorPage>');

        const imageWrappers = postContent.querySelectorAll('.image');
        if (!imageWrappers?.length) return Promise.resolve({});

        const postDescription =
          parsedHTML.getElementById('contentinner')?.querySelector('.post_description')?.innerText?.trim() || '';
        const postTitle = postDescription.split('/')[0]?.trim();
        const postTags = postDescription
          .split('/')[1]
          ?.trim()
          .split('::')
          .map((tag) => `#${tag.trim()}`)
          .join(' ');

        const authorAnchor = parsedHTML.getElementById('contentinner')?.querySelector('.uhead_nick a');
        const author = authorAnchor?.innerText || '';
        const authorURL = authorAnchor?.getAttribute('href')
          ? new URL(authorAnchor.getAttribute('href'), SafeParseURL(res.url).origin)
          : '';

        /** @type {import("../types/social-post").SocialPost} */
        const socialPost = {
          author,
          authorURL,
          caption: postTitle || postTags,
          postURL: postGettingUrl,
          medias: imageWrappers
            .map((imageWrapper) => {
              const fullAnchor = imageWrapper.querySelector('a');
              const defaultImageElem = imageWrapper.querySelector('img');

              /** @type {import("../types/social-post").Media} */
              const media = {};

              const defaultImage = ReactorPrepareUrl(defaultImageElem?.getAttribute('src'));
              if (!defaultImage) return null;

              media.type = 'photo';
              media.externalUrl = FormViewerURL(defaultImage, SafeParseURL(defaultImage).origin);

              const full = ReactorPrepareUrl(fullAnchor?.getAttribute('href'));
              const extension = (full || defaultImage).match(/\.(?<extension>\w+)$/i)?.groups?.extension;
              media.filetype = extension;

              if (full) {
                if (extension === 'gif') {
                  media.type = 'gif';
                  media.externalUrl = FormViewerURL(full, SafeParseURL(full).origin);

                  const videoElem = imageWrapper.querySelector('video');
                  if (videoElem) {
                    /** Telegram sometimes cannot send .webm videos and gifs from .webm. If so, set to mp4 */
                    const matchingType = 'mp4';

                    const properSources = videoElem
                      .querySelectorAll('source')
                      .map((sourceElem) => ({
                        url: sourceElem.getAttribute('src'),
                        mimeType: sourceElem.getAttribute('type'),
                      }))
                      .filter(({ mimeType }) => url && new RegExp(`${matchingType}$`, 'i').test(mimeType));

                    const availableSource = ReactorPrepareUrl(properSources.pop()?.url);
                    if (availableSource) {
                      media.filetype = matchingType;
                      media.externalUrl = FormViewerURL(availableSource, SafeParseURL(availableSource).origin);
                    }
                  }

                  media.original = media.externalUrl;
                } else media.original = FormViewerURL(full, SafeParseURL(full).origin);
              }

              return media;
            })
            .filter(Boolean),
        };

        return Promise.resolve(socialPost);
      } catch (e) {
        return Promise.reject(e);
      }
    });
  });
};

/**
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const Coub = (url) => {
  const COUB_VIDEO_RX = /^\/view\/(?<videoID>\w+)/;
  const videoID = url.pathname.match(COUB_VIDEO_RX)?.groups?.videoID;
  if (!videoID) return Promise.resolve({});

  const postURL = `https://coub.com/view/${videoID}`;

  return fetch(postURL, {
    headers: {
      ...DEFAULT_HEADERS,
      referer: 'https://coub.com/',
    },
  })
    .then((res) => {
      if (!res.ok) return Promise.reject(new Error(`Status code ${res.status} ${res.statusText} (${res.url})`));

      return res.text();
    })
    .then((coubPage) => {
      try {
        const parsedHTML = parseHTML(coubPage);

        const coubPageCoubJson = parsedHTML.getElementById('coubPageCoubJson');
        if (!coubPageCoubJson) throw new Error('No <coubPageCoubJson> in <coubPage>');

        /** @type {import('../types/coub-post').CoubPost} */
        const post = JSON.parse(coubPageCoubJson.innerHTML.trim());

        if (!post.file_versions) return Promise.reject(new Error(`Coub ${postURL} does not have <file_versions>`));

        /** @type {import('../types/social-post').SocialPost} */
        const socialPost = {
          author: post.channel.title,
          authorURL: `https://coub.com/${post.channel.permalink}`,
          caption: post.title,
          postURL,
          medias: [],
        };

        let videoToMerge = '';
        let audioToMerge = '';

        if (post.file_versions.html5) {
          /** @type {import('../types/coub-post').QualityOption[]} */
          const videoQualities = Object.values(post.file_versions.html5.video) || [];
          /** @type {import('../types/coub-post').QualityOption[]} */
          const audioQualities = Object.values(post.file_versions.html5.audio) || [];

          videoToMerge = videoQualities.sort((prev, next) => next.size - prev.size).shift()?.url;
          audioToMerge = audioQualities.sort((prev, next) => next.size - prev.size).shift()?.url;
        } else if (post.file_versions.mobile) {
          videoToMerge = post.file_versions.mobile.video;
          audioToMerge = post.file_versions.mobile.audio.pop();
        } else videoToMerge = post.file_versions.share?.default;

        return VideoAudioMerge(videoToMerge, audioToMerge, { loopVideo: true })
          .catch(() => Promise.resolve({ externalUrl: videoToMerge }))
          .then((videoAudioMerged) => {
            if ('externalUrl' in videoAudioMerged)
              socialPost.medias.push({
                externalUrl: videoAudioMerged.externalUrl,
                type: 'video',
              });
            else if ('filename' in videoAudioMerged)
              socialPost.medias.push({
                type: 'video',
                otherSources: {
                  audioSource: videoAudioMerged.audioSource,
                  videoSource: videoAudioMerged.videoSource,
                },
                filename: videoAudioMerged.filename,
                filetype: SafeParseURL(videoAudioMerged.videoSource).pathname.split('.').pop(),
                fileCallback: videoAudioMerged.fileCallback,
              });

            return Promise.resolve(socialPost);
          });
      } catch (e) {
        return Promise.reject(e);
      }
    });
};

const ALL_PARSERS = {
  AnimePictures,
  Danbooru,
  Eshuushuu,
  Gelbooru,
  Instagram,
  Konachan,
  Pixiv,
  PixivDirect,
  Reddit,
  Sankaku,
  Tumblr,
  Twitter,
  TwitterDirect,
  Yandere,
  Zerochan,
  KemonoParty,
  Youtube,
  Osnova,
  Joyreactor,
  Coub,
};

/** @typedef {keyof ALL_PARSERS} PlatformEnum */
/**
 * @param {PlatformEnum} platform
 * @param {URL} url
 * @returns {Promise<import("../types/social-post").SocialPost>}
 */
const SocialParser = (platform, url) => {
  const platformParser = ALL_PARSERS[platform];
  if (!platformParser || !url) return Promise.resolve({});

  return platformParser(url);
};

export default SocialParser;

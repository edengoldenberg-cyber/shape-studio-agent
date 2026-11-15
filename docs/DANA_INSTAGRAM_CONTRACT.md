# Dana — Instagram publishing and insights contract (as implemented, not yet exercised live)

Verified against official Meta documentation on **2026-11-15** (pages on developers.facebook.com; the
fetch tool relays a reading of each page, so every item below must be confirmed by the first live call).
Implemented in `services/dana_instagram.js`. Contract-tested against a local fake
(`tests/dana_instagram.test.js`). **No request has been made to a real account.**

## Selected configuration

| Choice | Value | Why |
|---|---|---|
| Login flow | **Facebook Login for Business** (`DANA_IG_LOGIN=facebook`) | The only flow documented with resumable upload, so the video goes from the server straight to Meta and no public media URL is needed. Requires the Instagram professional account to be linked to a Facebook Page |
| Host | `graph.facebook.com`, upload `rupload.facebook.com` | per flow |
| API version | **v26.0** pinned (`DANA_IG_API_VERSION`) | Latest version present in the official versions table (released 2026-07-29). The changelog also lists v27.0 (2026-11-04) but the versions table has no row for it yet |
| Permissions | `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement` (+ `ads_management` / `ads_read` only if the Page role comes through Business Manager) | publishing + media insights + account discovery |
| Access level | Standard Access, no App Review | documented for "My app is only for a business I own or manage" |
| Token | long-lived token of a person with a role on the app and the Page (about 60 days), or the long-lived Page token derived from it (documented as not expiring) | The docs disagree on Page vs User token for publishing: the guide says Page token, the reference pages say User token. To be settled by the read-only probe |

Not selected: **Instagram Login** (`graph.instagram.com`) — publishing needs `video_url` on a public
server ("We cURL the video … so it must be on a public server"); Dana does not expose media publicly,
so with this flow the adapter refuses (`signed_url_disabled`). **Unified Login** is described as the
recommended setup for new integrations but is framed around business clients; not evaluated further.

## Requests the adapter makes

| Step | Request | Notes |
|---|---|---|
| Who am I (read-only) | `GET /{version}/{ig-user-id}?fields=id,username` | must equal the approved destination account before anything is created |
| Quota (read-only) | `GET /{ig-user-id}/content_publishing_limit?fields=quota_usage,config` | docs say both 50 and 100 per 24 h; the live value is read |
| Container | `POST /{ig-user-id}/media` with `media_type=REELS`, `upload_type=resumable`, `caption`, `share_to_feed=true`, `thumb_offset` (ms) | returns `id` and `uri` |
| Upload | `POST https://rupload.facebook.com/ig-api-upload/{version}/{container-id}` headers `Authorization: OAuth <token>`, `offset: 0`, `file_size`, body = file bytes | success = `{"success":true}`; the `uri` is used only if it is on the upload host |
| Status | `GET /{container-id}?fields=status_code,status` | `EXPIRED`, `ERROR`, `FINISHED`, `IN_PROGRESS`, `PUBLISHED`; Meta recommends once a minute for up to 5 minutes; containers expire after 24 h |
| Publish | `POST /{ig-user-id}/media_publish?creation_id=` | returns the media `id`; not-ready = code 9007 / 2207027; limit = code 9 / 2207042 |
| Verify | `GET /{media-id}?fields=id,permalink,caption,timestamp,media_product_type` | "published" requires media id + permalink; the caption is compared with the approved one |
| Reconcile | `GET /{ig-user-id}/media?fields=id,caption,timestamp,permalink,media_product_type&limit=10` | no idempotency key exists; after an unknown outcome the post is searched by caption + time (an inference; anything but exactly one match stays "uncertain") |
| Insights | `GET /{media-id}/insights?metric=views,reach,likes,comments,saved,shares,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time` | lifetime values; data can lag up to 48 h; `plays` / `impressions` are deprecated |

Errors: `{"error":{message,type,code,error_subcode,fbtrace_id}}`. Mapped: 190/102 → `auth_expired`;
4, 17, 32, 613, 341, 80002 → `rate_limited`; 10 and 200–299 → `permission_missing`; 9/2207042 →
`publishing_limit_reached`. The token is sent only in the `Authorization` header and is scrubbed from
every stored or logged message.

Video file: the pipeline's output is MP4, H.264, AAC 48 kHz, 25 fps, 1080x1920, about 9 Mb/s, well
under the documented limits (H.264/HEVC, 23–60 fps, ≤25 Mb/s, 3 s–15 min, ≤300 MB).

## Cover

Through the API the cover is either `cover_url` (a JPEG on a **public** server) or `thumb_offset`
(a frame of the video). Dana uses `thumb_offset` at the plan's cover frame, so the published cover is
that frame **without** the text layer. The review page says so. The designed cover with text is in
the package and can be set by hand in the Instagram app after publication. Serving a cover from a
public URL is not implemented (owner decision).

## Not verified — to be settled by the first live calls

1. Whether the Graph API accepts the token in the `Authorization: Bearer` header for these endpoints (the docs' samples pass `access_token` as a parameter; the header is used to keep the token out of URLs).
2. Page token vs User token for publishing under Facebook Login.
3. Caption line breaks (not stated in the docs).
4. Behaviour of `media_publish` on an already-published container (not documented) — Dana never retries it blindly.
5. The actual publishing quota (50 vs 100).
6. Whether `caption` and `media_product_type` are returned for the media (one page marks them "Facebook Login only" — consistent with the selected flow).
7. Units of the two watch-time metrics.
8. v27.0 availability and expiry.

## Sources (read 2026-11-15)

- https://developers.facebook.com/docs/graph-api/changelog · https://developers.facebook.com/docs/graph-api/changelog/versions
- https://developers.facebook.com/docs/instagram-platform/overview · https://developers.facebook.com/docs/instagram-platform/app-review
- https://developers.facebook.com/docs/instagram-platform/content-publishing
- https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads.md
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
- https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
- https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started
- https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
- https://developers.facebook.com/docs/graph-api/guides/error-handling · https://developers.facebook.com/docs/graph-api/overview/rate-limiting
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes

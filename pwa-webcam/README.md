This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## WebRTC session logs

Open the **browser DevTools Console on the device running the PWA** and filter
for `[webrtc-session]`. The same JSON records are persisted in this browser's
localStorage under `webrtc-session`, retaining the most recent 2,000 events
across reloads. They are not sent to the receiver or a logging service.
If storage is unavailable or full, records remain available in page memory.

Use **Copy session stats** on the home or streaming screen to copy formatted
JSON containing the latest summary for every retained session and the full
retained event history. This includes durations, end reasons, averages, sample
counts, errors, and lifecycle counts. Older events beyond the retention limit
are discarded. Clipboard failures show a retry message.

Each peer connection emits `session-start`, `session-connected` (once),
`session-stats` every second after a successful `getStats()`, and `session-end`
on cleanup (stop, remote termination, connection failure, or unmount).
The JSON includes a page ID (to distinguish reloads/tabs), a page-local session ID, timestamp, duration, end reason,
RTT/jitter sample counts, and counts of started, connected, ended, and active
sessions. Counts reset on page reload; reconnecting the same peer does not
increment them. Attempts that fail before creating a peer are not counted.

`averageRttMs` and `averageJitterMs` are running arithmetic averages of valid
`remote-inbound-rtp.roundTripTime` and `.jitter` samples across outgoing audio
and video streams, converted from seconds to milliseconds. Each stream/poll
has equal weight, including repeated values between RTCP reports; these are
sample averages, not packet-weighted averages. Missing metrics stay `null`
with zero samples. See the [WebRTC stats specification](https://www.w3.org/TR/webrtc-stats/#remoteinboundrtpstats-dict*).
`stats-error` records failed polls, which do not contribute to the averages.

The end event summarizes all completed polls; in-flight polls are discarded
on cleanup. Abrupt tab/browser termination may prevent the end event, so
periodic records also contain the running averages and counts.

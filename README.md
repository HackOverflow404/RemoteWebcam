# PixelStreamer

**PixelStreamer** is a secure, real-time webcam and microphone streaming application that enables peer-to-peer (P2P) communication between your phone and your Linux desktop using WebRTC. The project uses Firebase as a signaling server via Cloud Functions, with a beautiful native Qt UI on the desktop side and a modern React/Next.js frontend on mobile.

---

## Features

- **Secure 5-character pairing code** to initiate a connection
- **Qt-based native desktop app** (Linux)
- **React-based phone UI** (Next.js + WebRTC)
- **Serverless Firebase backend** (Cloud Functions + Firestore)
- Real-time video/audio streaming from phone to laptop
- Automatic connection cleanup and lifecycle management
- Lightweight and fast — perfect for remote webcam use, streaming, or telepresence

---

## Architecture

1. The QtPython Linux app requests code from a firebase function [generateCode](https://generatecode-qaf2yvcrrq-uc.a.run.app)
2. The Linux app begins polling for an SDP offer using a firebase function [checkOffer](https://checkoffer-qaf2yvcrrq-uc.a.run.app)
3. The code is entered on the Home component of the Next.js Mobile PWA
4. The PWA validates the code using a firebase function [validateCode](https://validatecode-qaf2yvcrrq-uc.a.run.app)
5. The PWA routes to the Stream Page component of the Next.js Mobile PWA
6. The Stream Page component generates a SDP offer and ICE candidates
7. The PWA updates the code doc in the firestore with the SDP offer via firebase function [submitOffer](https://submitoffer-qaf2yvcrrq-uc.a.run.app)
8. The PWA begins polling for an SDP answer via a firebase function [checkAnswer](https://checkanswer-qaf2yvcrrq-uc.a.run.app)
9. The QtPython Linux app detects a SDP offer and generates an SDP answer with ICE candidates
10. The Linux app updates the code doc with the SDP answer and the ICE candidates through a firebase function [submitAnswer](https://submitanswer-qaf2yvcrrq-uc.a.run.app)
11. The PWA detects an SDP answer and establishes a connection

---

## Tech Stack

| Component | Technology |
|----------|------------|
| Phone Frontend | React + Next.js + Tailwind CSS + TypeScript + WebRTC |
| Laptop App | Python 3 + PyQt6 + aiortc |
| Backend | Firebase (Firestore, Cloud Functions, Hosting) |
| Signaling | Firebase Firestore |
| Media | WebRTC Peer-to-Peer |

## Screenshots

### Laptop App (Qt UI)
<img src="./assets/laptop-ui.png" alt="Laptop UI" width="600"/>

### Phone App (React Web)
<img src="./assets/phone-ui.png" alt="Phone UI" width="300"/>
<img src="./assets/stream-ui.png" alt="Stream UI" width="300"/>


## Running the Linux app

```bash
cd linux-app
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

Requirements: PipeWire (`pw-cat`, `pactl`, `pw-dump`) and the `v4l2loopback`
DKMS module. On first launch the app creates its own loopback device labelled
**PixelStreamer** (one polkit prompt). If v4l2loopback is already loaded by
another app, a device is added alongside, and existing devices are left
untouched. The virtual camera ("PixelStreamer") and microphone ("PixelStreamer
Virtual Mic") stay available for as long as the app runs. Between sessions
they carry black video and silence, so other apps keep them selected across
reconnects.

## Deploying the backend

```bash
cd firebase/functions && npm run deploy
```

`checkOffer` / `checkAnswer` accept a `waitMs` long-poll parameter, and both
clients use it. Older clients and servers still interoperate, because the
clients fall back to short polling.

Codes carry an `expiresAt` field, 24 h after creation. To have Firestore delete
abandoned codes automatically, enable a TTL policy once:

```bash
gcloud firestore fields ttls update expiresAt --collection-group=codes --enable-ttl
```

Each function cold-starts separately. The PWA warms the ones it needs while the
code is being typed. Setting `minInstances` on `checkOffer`, `checkAnswer` and
`getTurnCredentials` removes cold starts entirely, at a small monthly cost.

### TODO:
ICE restart / renegotiation so a session survives a network change (needs a
signaling channel that stays open during the session).

Limit CORS to only the deployed link

Rate Limiting or Abuse Protection
Use Firebase App Check or limiting requests per IP.

Secure Data Structuring
Move signaling data into subcollections under /codes/{code}/signals if you want finer access control.
Mask or encrypt metadata.

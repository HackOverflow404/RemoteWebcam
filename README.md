# PixelStreamer 🎥

**PixelStreamer** is a secure, real-time webcam and microphone streaming application that enables peer-to-peer (P2P) communication between your phone and your Linux desktop using WebRTC. The project uses Firebase as a signaling server via Cloud Functions, with a beautiful native Qt UI on the desktop side and a modern React/Next.js frontend on mobile.

---

## 🚀 Features

- 🔐 **Secure 5-character pairing code** to initiate a connection
- 🖥️ **Qt-based native desktop app** (Linux)
- 📱 **React-based phone UI** (Next.js + WebRTC)
- ☁️ **Serverless Firebase backend** (Cloud Functions + Firestore)
- 🎥 Real-time video/audio streaming from phone to laptop
- 🔄 Automatic connection cleanup and lifecycle management
- 📦 Lightweight and fast — perfect for remote webcam use, streaming, or telepresence

---

## 🏗️ Architecture

1. Laptop app generates a code and uploads a placeholder doc to Firestore via Cloud Function (`generateCode`)
2. Phone enters the code, uploads the offer and ICE candidates (`retrieveCode`)
3. Laptop polls with exponential backoff for status (`checkCodeStatus`)
4. Laptop reads the offer, submits answer and candidates via Cloud Function (`submitAnswer`)
5. Phone polls for SDP answer and picks up the answer to finalize the connection

---

## 🛠️ Tech Stack

| Component | Technology |
|----------|------------|
| 📱 Phone Frontend | React + Next.js + Tailwind CSS + TypeScript + WebRTC |
| 🖥️ Laptop App | Python 3 + PyQt5 + aiortc |
| ☁️ Backend | Firebase (Firestore, Cloud Functions, Hosting) |
| 🔄 Signaling | Firebase Firestore |
| 🧪 Media | WebRTC Peer-to-Peer |

## 🖼️ Screenshots

### Laptop App (Qt UI)
![Laptop UI](./assets/laptop-ui.png)

### Phone App (React Web)
![Phone UI](./assets/phone-ui.png)
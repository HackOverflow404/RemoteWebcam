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
<img src="./assets/laptop-ui.png" alt="Laptop UI" width="600"/>

### Phone App (React Web)
<img src="./assets/phone-ui.png" alt="Phone UI" width="300"/>
<img src="./assets/stream-ui.png" alt="Stream UI" width="300"/>


### TODO:
Add renegotiation logic for WebRTC

Expiry for Codes
Add TTL logic or clean-up mechanism:
```
// Suggestion: Add this field when setting the code
expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)) // 10 mins
```
Add a scheduled function to remove expired codes.

Limit CORS to only the deployed link

Rate Limiting or Abuse Protection
Use Firebase App Check or limiting requests per IP.

Additional Logging
Log the actual code being generated and track failures more granularly:
```
functions.logger.info("Generated Code:", code);
```

Type Safety & Input Validation
Use a schema validator (e.g. Zod or Joi) in production for complex payloads like SDP.

Secure Data Structuring
Move signaling data into subcollections under /codes/{code}/signals if you want finer access control.
Mask or encrypt metadata.

CI/CD integration

---

### Notes
🔐 1. Use HTTPS and TLS Everywhere
This is non-negotiable:

Use TLS 1.2 or 1.3 with strong cipher suites.

Your Firebase Firestore (or equivalent database) should only be accessed over HTTPS.

Do not use HTTP, even on localhost in production.

🔐 2. Generate Secure 5-Character Codes
These codes are sensitive entry points to a session. Ensure:

✅ Best Practices:
Use a cryptographically secure random generator (e.g., crypto.randomUUID() or crypto.getRandomValues() in JS, secrets in Python).

Avoid easily guessable codes (e.g., sequential, dictionary words).

Use alphanumeric mixed case, and consider increasing length to 6–8 characters for better entropy.

🔑 A 5-character base36 code (A-Z0-9) has ~60 bits of entropy — acceptable for short-lived, non-persistent sessions but not brute-force resistant at scale.

🛡️ 3. Secure Storage in the Database
Even though the code is public (shared between desktop and mobile), the WebRTC SDP offer/answer and ICE candidates should be treated as sensitive.

✅ Best Practices:
Encrypt the offer/answer data at rest, if your database doesn't already do so (Firestore does).

Restrict Firestore rules so that:

Only authenticated or validated clients can read/write to their specific session document

Each client (desktop or mobile) can only access their session document, not others

Example Firestore rules:

js
Copy
Edit
match /codes/{code} {
  allow read, write: if request.auth != null && request.auth.uid == resource.data.owner;
}
🔑 4. Prevent Session Hijacking or Code Guessing
✅ Rate limiting and brute-force prevention:
Limit read attempts on the code lookup endpoint (mobile side).

Throttle IPs that repeatedly try invalid codes.

Store session creation timestamps and auto-expire codes after 5–10 minutes.

🔄 5. Secure SDP Payloads
The SDP offer/answer themselves contain:

Media stream information

ICE servers (TURN/STUN credentials)

IP addresses (public + private)

✅ Best Practices:
Never expose SDP payloads to other clients

Encrypt the signaling path (you already do this via Firestore over HTTPS)

Use short-lived TURN credentials (e.g., via Twilio’s expiring auth tokens)

🔐 Summary Table of Encryption & Security Standards
Step	Security Best Practice
Code generation	Use cryptographically secure RNG, consider increasing code length
Code transmission	Always over HTTPS/TLS 1.2+
Database storage	Use Firestore or similar with encryption at rest
Access control	Use Firestore rules to scope access per session
SDP exchange	Secure through HTTPS, limit visibility
TURN/STUN	Use short-lived credentials (e.g., ICE servers with expiring tokens)
Expiry & cleanup	Auto-delete codes after session expires


✅ 1. Transport Layer: Use HTTPS and Secure WebSockets
Always serve your signaling server over HTTPS.

Use WSS (Secure WebSocket) if using WebSockets for signaling.

Firebase Firestore / Realtime DB already enforces HTTPS, so you're good if you're using Firebase.

🔐 This ensures TLS encryption between client and server, protecting against MITM (man-in-the-middle) attacks.

✅ 2. Data Layer: Encrypt Sensitive Payloads (Optional but Recommended)
The WebRTC SDP offer/answer contains potentially sensitive metadata (IP addresses, codecs, ICE candidates).

While TLS secures transit, you can add application-level encryption (e.g., using AES-GCM or NaCl) if you want to:

Prevent the backend from accessing signaling data (zero-trust)

Store offers/answers in a public or minimally trusted store (e.g., Firebase)

Recommended:
Use AES-GCM (256-bit) to encrypt the offer and answer

Derive a shared secret key from the 5-character code using a KDF (like PBKDF2 or HKDF)

✅ 3. Code Security: Make Codes Unguessable
A 5-character code (even alphanumeric) gives:

36⁵ = ~60 million possible combinations (if using [a-z0-9])

✅ Sufficient for short-term, one-time use

❌ Not secure for long-term storage or publicly exposed codes

Best Practices:
Ensure codes expire after use or after X minutes

Consider rate limiting lookups to prevent brute-force guessing

Add an optional HMAC or digital signature per message for authenticity

✅ 4. Database Security (Firestore or Custom DB)
Use rules to restrict read/write access:

Only allow writes/reads to codes/{code} by devices that know {code}

Prevent list/enumeration access

In Firebase, use Firestore Security Rules

Example Firebase rule:

js
Copy
Edit
match /codes/{code} {
  allow read, write: if request.auth == null && code == request.resource.id;
}
✅ 5. Optional: Use Ephemeral Encryption Keys Per Session
To prevent even the server from reading the payload, you can:

Derive a symmetric AES key from the code using PBKDF2 (with a salt you don’t store)

Encrypt the offer/answer using this key

Both clients perform the same derivation and decryption

✅ This makes your signaling server zero-knowledge and secure even if compromised.

🧠 Summary: Best Practices for Your Flow
Area	Practice
Transport	Use HTTPS/WSS, not HTTP/WS
Code Design	Use unguessable, short-lived codes
Database	Enforce strict access rules (per-code), rate limiting, no listing
Data Encryption	Optional but recommended: encrypt SDP with AES-GCM, key derived from code
Auth	Use HMAC or shared-secret for integrity if you can't use TLS alone
Firebase Rules	Write rules so only clients with a valid code can read/write that document
Expiry	Clean up used/old codes after X minutes to reduce attack surface
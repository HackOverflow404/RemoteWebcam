**PWA — connection & pairing**
- QR code-based signaling/pairing exchange
- STUN/TURN for connections across different networks (not just same LAN)
- Saved device/pairing memory via localStorage or IndexedDB
- Connection quality indicator using WebRTC's `getStats()`
- Reconnect logic for WiFi drops and app foreground/background transitions (with the caveat that a deliberate screen lock via the power button still suspends WebRTC regardless of your reconnect code — you can only resume cleanly once it's unlocked again)
- Local-only mode toggle that skips Firebase signaling when you can establish a direct local connection

**PWA — stream quality**
- Adaptive bitrate (built into WebRTC)
- Codec preference toward hardware-accelerated H.264
- Manual resolution/fps presets via standard `getUserMedia` constraints
- Front/back camera switching via `facingMode`

**PWA — image processing (software, not hardware control)**
- Digital zoom by cropping/scaling the captured frame on canvas
- Mirror/flip as a software transform
- Virtual background or portrait blur via client-side ML segmentation on the captured frames
- Color/exposure filters and low-light boost as software post-processing (an approximation of real exposure control, not the real thing)

**PWA — reliability & UX**
- Screen Wake Lock API (works on iOS 16.4+, and the installed-PWA bug was fixed in 18.4) — though note an active camera track already keeps the screen awake on its own per WebKit's own fix, so this may mostly be a safety net for other app states
- Local recording to a file via `MediaRecorder`
- Built-in glass-to-glass latency measurement (your QR/timestamp approach) as a live overlay, not just an offline test
- Ongoing stats logging via `getStats()`
- App-level access control/authentication before allowing a connection
- Graceful error/degradation messaging when a connection attempt fails

**Linux desktop app (Qt/Python side — no iOS restrictions apply here at all)**
- `v4l2loopback` virtual camera registration so any app sees it as a normal webcam
- Virtual microphone via PulseAudio/PipeWire with audio/video sync correction
- Self-hosted TURN server (e.g. coturn) for the NAT-traversal cases above
- systemd service/autostart
- Tray icon/status indicator
- Network condition simulation for testing (`tc`/`netem`) — this lives on the desktop side, not in the PWA
- Local recording on the desktop side as an alternative/backup to phone-side recording

- Benchmarking

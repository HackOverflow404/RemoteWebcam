async function fetchIceServers() {
  const resp = await fetch(
    'https://getturncredentials-qaf2yvcrrq-uc.a.run.app',
    { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }
  );

  // resp.json() is already an array of ICE‐server objects
  const iceServers = await resp.json();  
  return iceServers;
  // console.log('ICE servers fetched:', iceServers);
  // return [{"url": "stun:stun.l.google.com:19302"}]
}

document.getElementById('start').addEventListener('click', async () => {
  const code = prompt("Enter the session code from the Python app:");
  if (!code) return;

  const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: true
  });

  document.getElementById('localVideo').srcObject = stream;
  stream.getTracks().forEach(track => pc.addTrack(track, stream));

  const dc = pc.createDataChannel('chat');
  dc.onopen    = () => { dc.send('Hello from JS!'); };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
 
  await new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
    } else {
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        }
      });
    }
  });
 
  await fetch("https://submitoffer-qaf2yvcrrq-uc.a.run.app", {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ code, offer: pc.localDescription })
  });

  let answerDesc;
  while (!answerDesc) {
    const resp = await fetch("https://checkanswer-qaf2yvcrrq-uc.a.run.app", {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ code })
    });
    if (resp.status === 200) {
      const { answer } = await resp.json();
      answerDesc = new RTCSessionDescription(answer);
    } else {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  await pc.setRemoteDescription(answerDesc);
  console.log('✅ WebRTC connection (media+data) established!');
});
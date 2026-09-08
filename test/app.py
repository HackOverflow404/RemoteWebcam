import time
import requests
import asyncio
import cv2
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceServer,
    RTCConfiguration
)

# your existing URLs…
GENERATE_CODE_URL = "https://generatecode-qaf2yvcrrq-uc.a.run.app"
CHECK_OFFER_URL    = "https://checkoffer-qaf2yvcrrq-uc.a.run.app"
SUBMIT_ANSWER_URL  = "https://submitanswer-qaf2yvcrrq-uc.a.run.app"
GET_TURN_URL       = "https://getturncredentials-qaf2yvcrrq-uc.a.run.app"

def generate_code():
    r = requests.post(GENERATE_CODE_URL, json={})
    r.raise_for_status()
    return r.json()["code"]

def wait_for_offer(code):
    while True:
        r = requests.post(CHECK_OFFER_URL, json={'code': code})
        if r.status_code == 200 and r.json().get('offer'):
            return r.json()['offer']
        time.sleep(1)

def get_ice_configuration():
    resp = requests.post(GET_TURN_URL, json={})
    raw = resp.json()
    ice_servers = []
    for s in raw:
        urls = s.get('urls') or s.get('url')
        ice_servers.append(
            RTCIceServer(
                urls=urls,
                username=s.get('username'),
                credential=s.get('credential')
            )
        )
    return RTCConfiguration(iceServers=ice_servers)
    # return RTCConfiguration(
    #     iceServers=[RTCIceServer(urls="stun:stun.l.google.com:19302")]
    # )

exit_event = asyncio.Event()

async def render_video(track):
    """Pull frames from `track` and show them until 'q' is pressed."""
    while True:
        try:
            frame = await track.recv()
        except Exception:
            break

        img = frame.to_ndarray(format="bgr24")
        cv2.imshow("Remote", img)

        # if user presses 'q', signal exit
        if cv2.waitKey(1) & 0xFF == ord('q'):
            exit_event.set()
            break

    # done or user quit
    cv2.destroyWindow("Remote")
    exit_event.set()

async def main():
    # 1) generate code, wait for offer…
    code = generate_code()
    print(f"🔑 Session code: {code}")
    print("⏳ Waiting for JS offer…")
    offer_json = wait_for_offer(code)
    offer = RTCSessionDescription(sdp=offer_json['sdp'], type=offer_json['type'])
    print("✅ Got JS offer")

    # 2) prepare PC + ICE
    config = get_ice_configuration()
    pc = RTCPeerConnection(configuration=config)

    @pc.on("track")
    def on_track(track):
        print(f"▶️  Received {track.kind} track")
        if track.kind == "video":
            # start rendering task
            asyncio.create_task(render_video(track))

    # 3) SDP handshake
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    
    gather_complete = asyncio.get_event_loop().create_future()

    @pc.on("icegatheringstatechange")
    def on_icegathering():
        if pc.iceGatheringState == "complete" and not gather_complete.done():
            gather_complete.set_result(True)

    await gather_complete

    # 4) send back the answer
    requests.post(SUBMIT_ANSWER_URL, json={
        'code': code,
        'answer': {'sdp': pc.localDescription.sdp,
                   'type': pc.localDescription.type}
    })
    print("✅ Answer sent — awaiting media…")

    # 5) wait for connection
    conn_fut = asyncio.get_event_loop().create_future()
    @pc.on("connectionstatechange")
    def on_connstate():
        if pc.connectionState == "connected" and not conn_fut.done():
            conn_fut.set_result(True)
    await conn_fut

    print("🔗 Connected — rendering video. Press 'q' to quit.")
    # create the window once
    cv2.namedWindow("Remote", cv2.WINDOW_NORMAL)

    # 6) wait until render_video sets exit_event
    await exit_event.wait()

    # 7) cleanup
    await pc.close()
    cv2.destroyAllWindows()
    print("🏁 Done.")

if __name__ == "__main__":
    asyncio.run(main())
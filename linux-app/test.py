import asyncio
import json
import requests
from aiortc import RTCPeerConnection, RTCIceServer, RTCConfiguration

GENERATE_CODE_URL = "http://localhost:5001/remote-webcam-b70ab/us-central1/generateCode"

async def create_offer_and_get_code():
    # Set up ICE configuration with a STUN server
    ice_servers = [RTCIceServer(urls=["stun:stun.l.google.com:19302"])]
    config = RTCConfiguration(iceServers=ice_servers)

    # Create the RTC connection with the configuration
    pc = RTCPeerConnection(config)

    ice_candidates = []

    # Create data channel to trigger ICE candidate gathering
    pc.createDataChannel("init")

    # ICE candidate collection callback
    @pc.on("icecandidate")
    def on_icecandidate(event):
        if event.candidate:
            temp = event.candidate.to_sdp()
            ice_candidates.append(temp)
            print("Appended ICE candidate:", temp)

    # Monitor ICE gathering state
    @pc.on("icegatheringstatechange")
    def on_icegatheringstatechange():
        print(f"ICE gathering state: {pc.iceGatheringState}")

    # Create offer
    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    # Wait for ICE gathering to complete (this can take a bit of time)
    async def wait_for_ice_complete():
        while True:
            await asyncio.sleep(0.1)
            if pc.iceGatheringState == "complete":
                break

    await wait_for_ice_complete()

    print(f"Gathered ICE candidates: {json.dumps(ice_candidates, indent=2)}")

    # Prepare the payload to send to Cloud Function
    payload = {
        "data": {
            "offer": pc.localDescription.sdp,
            "iceCandidates": ice_candidates
        }
    }

    headers = {"Content-Type": "application/json"}
    response = requests.post(GENERATE_CODE_URL, data=json.dumps(payload), headers=headers)
    response.raise_for_status()

    code = response.json()["result"]["code"]
    print(f"✅ Code generated and stored: {code}")
    return code

if __name__ == "__main__":
    asyncio.run(create_offer_and_get_code())

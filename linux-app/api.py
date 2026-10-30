"""HTTP client for the PixelStreamer Firebase signaling functions."""
import threading
import time

import requests

GENERATE_CODE_URL = "https://generatecode-qaf2yvcrrq-uc.a.run.app"
DELETE_CODE_URL = "https://deletecode-qaf2yvcrrq-uc.a.run.app"
CHECK_OFFER_URL = "https://checkoffer-qaf2yvcrrq-uc.a.run.app"
SUBMIT_ANSWER_URL = "https://submitanswer-qaf2yvcrrq-uc.a.run.app"
GET_TURN_URL = "https://getturncredentials-qaf2yvcrrq-uc.a.run.app"

FALLBACK_ICE_SERVERS = [{"urls": "stun:stun.l.google.com:19302"}]

# Server holds checkOffer open up to this long (older deployments ignore it
# and answer immediately, in which case we fall back to short polling).
LONG_POLL_MS = 25_000
CONNECT_TIMEOUT_S = 5
# Stop waiting for the phone after this long. An open long-poll is billed as
# Cloud Run instance time, so an unbounded wait (code left showing in the
# tray all day) could exceed the free tier; this caps each code at ~10 min.
OFFER_WAIT_LIMIT_S = 10 * 60

_local = threading.local()


class CodeGone(Exception):
    """The pairing code no longer exists or has expired."""


class OfferTimeout(Exception):
    """No phone connected within OFFER_WAIT_LIMIT_S."""


def _session() -> requests.Session:
    # One keep-alive session per thread: reusing the TLS connection saves a
    # handshake (~100-300 ms) on every signaling request.
    s = getattr(_local, "session", None)
    if s is None:
        s = _local.session = requests.Session()
    return s


def _post(url: str, payload: dict, timeout: float = 10) -> requests.Response:
    return _session().post(url, json=payload, timeout=(CONNECT_TIMEOUT_S, timeout))


def _post_retry(url: str, payload: dict, attempts: int = 3, timeout: float = 10) -> requests.Response:
    delay = 0.5
    for i in range(attempts):
        try:
            r = _post(url, payload, timeout)
            if r.status_code < 500:
                return r
        except requests.RequestException:
            if i == attempts - 1:
                raise
        time.sleep(delay)
        delay *= 2
    return r


def generate_code() -> str:
    r = _post_retry(GENERATE_CODE_URL, {})
    r.raise_for_status()
    return r.json()["code"]


def delete_code(code: str, attempts: int = 3) -> None:
    _post_retry(DELETE_CODE_URL, {"code": code}, attempts=attempts, timeout=5)


def get_ice_servers() -> list:
    try:
        r = _post_retry(GET_TURN_URL, {}, attempts=2)
        servers = r.json() if r.ok else None
        if isinstance(servers, list) and servers:
            return servers
        print(f"[api] TURN credentials unavailable (HTTP {r.status_code}); using STUN only")
    except Exception as e:
        print(f"[api] TURN credentials request failed ({e!r}); using STUN only")
    return FALLBACK_ICE_SERVERS


def wait_for_offer(code: str, stop: threading.Event):
    """
    Block until the phone submits an offer for `code` and return it, or return
    None if `stop` is set. Raises CodeGone if the code was deleted/expired and
    OfferTimeout after OFFER_WAIT_LIMIT_S. Network errors are retried.
    """
    deadline = time.monotonic() + OFFER_WAIT_LIMIT_S
    backoff = 0.5
    while not stop.is_set():
        started = time.monotonic()
        remaining_ms = int((deadline - started) * 1000)
        if remaining_ms <= 0:
            raise OfferTimeout(code)
        wait_ms = min(LONG_POLL_MS, remaining_ms)
        try:
            r = _post(CHECK_OFFER_URL, {"code": code, "waitMs": wait_ms},
                      timeout=wait_ms / 1000 + 10)
        except requests.RequestException as e:
            print(f"[api] checkOffer failed ({type(e).__name__}); retrying in {backoff:.1f}s")
            stop.wait(backoff)
            backoff = min(backoff * 2, 10)
            continue

        if r.status_code == 200:
            offer = r.json().get("offer")
            if offer:
                return offer
        elif r.status_code in (404, 410):
            raise CodeGone(code)
        elif r.status_code != 204:
            stop.wait(backoff)
            backoff = min(backoff * 2, 10)
            continue

        backoff = 0.5
        if time.monotonic() - started < 1.0:
            stop.wait(0.5)  # server didn't long-poll; don't hammer it
    return None


def submit_answer(code: str, answer: dict) -> None:
    r = _post_retry(SUBMIT_ANSWER_URL, {"code": code, "answer": answer})
    if r.status_code in (404, 410):
        raise CodeGone(code)
    if r.status_code == 409:
        return  # an earlier attempt that timed out client-side already landed
    r.raise_for_status()

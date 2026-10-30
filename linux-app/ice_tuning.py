"""
Faster ICE candidate gathering for aiortc.

aiortc has no trickle ICE, so the answer can't be sent until gathering
finishes. aioice queries the STUN server from *every* local interface and
waits up to 5 s for all of them; an interface without internet access (VPN
such as Tailscale, docker bridges, ...) never answers, so every connection
paid the full 5 s.

This finishes gathering as soon as the TURN allocation (if any) has
completed and at least one STUN query has succeeded, keeping the 5 s cap as a
fallback. aioice only uses asyncio.wait() in its gathering step, so the patch
is confined to that call.
"""
import asyncio
import types

import aioice.ice

_SRFLX = "server_reflexive_candidate"
_RELAY = "relayed_candidate"


def _kind(task) -> str:
    coro = task.get_coro()
    return getattr(coro, "__name__", "") or getattr(getattr(coro, "cr_code", None), "co_name", "")


def _succeeded(task) -> bool:
    return task.done() and not task.cancelled() and task.exception() is None


async def _gather_wait(fs, *, timeout=None, return_when=asyncio.ALL_COMPLETED):
    pending = set(fs)
    done = set()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + (timeout if timeout is not None else 5)
    while pending:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        just_done, pending = await asyncio.wait(
            pending, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
        )
        done |= just_done
        relay_pending = any(_kind(t) == _RELAY for t in pending)
        have_srflx = any(_kind(t) == _SRFLX and _succeeded(t) for t in done)
        srflx_pending = any(_kind(t) == _SRFLX for t in pending)
        if not relay_pending and (have_srflx or not srflx_pending):
            break
    return done, pending


class _AsyncioProxy(types.ModuleType):
    wait = staticmethod(_gather_wait)

    def __getattr__(self, name):
        return getattr(asyncio, name)


def install() -> None:
    if not isinstance(aioice.ice.asyncio, _AsyncioProxy):
        aioice.ice.asyncio = _AsyncioProxy("asyncio")

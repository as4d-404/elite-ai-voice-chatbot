"""
Audio transcoding for the Gemini Live voice layer.

Gemini Live expects raw 16-bit little-endian PCM at 16kHz for input and
returns it at 24kHz for output. Twilio Media Streams, by contrast, carries
8kHz mu-law (g711 ulaw) audio base64-encoded.

OpenAI's Realtime API accepted Twilio's 8kHz mulaw natively, which is why the
old bridge had no conversion step. Gemini does not — so we bridge the gap here:

  Twilio (8kHz mulaw)  ->  mulaw8k_to_pcm16k  ->  Gemini (16kHz PCM)
  Gemini (24kHz PCM)   <-  pcm24k_to_mulaw8k  <-  Twilio (8kHz mulaw)

Conversion uses the `audioop` API, provided by the maintained `audioop-lts`
backport (Python removed the built-in `audioop` in 3.13). Both helpers are
streaming-safe: they hold resample state across calls so Twilio's arbitrary
chunk boundaries never produce gaps or glitches.

Note on audioop-lts: it is a drop-in reimplementation of Python's standard
`audioop` module, so it is imported as `import audioop`.
"""

import audioop

PCM_WIDTH = 2  # 16-bit little-endian samples (2 bytes each)

TWILIO_RATE = 8000   # Twilio Media Streams sample rate (mu-law)
GEMINI_IN_RATE = 16000   # Gemini Live input sample rate
GEMINI_OUT_RATE = 24000  # Gemini Live output sample rate


class Mulaw8kToPcm16k:
    """Streaming 8kHz mu-law -> 16kHz 16-bit PCM converter."""

    def __init__(self) -> None:
        self._rate_state = None

    def convert(self, mulaw: bytes) -> bytes:
        """Convert a chunk of mu-law bytes to 16kHz 16-bit PCM bytes."""
        if not mulaw:
            return b""
        # mu-law decodes 1 byte per frame into a 2-byte (16-bit) PCM sample.
        pcm_8k = audioop.ulaw2lin(mulaw, PCM_WIDTH)
        out, self._rate_state = audioop.ratecv(
            pcm_8k, PCM_WIDTH, 1, TWILIO_RATE, GEMINI_IN_RATE, self._rate_state
        )
        return out


class Pcm24kToMulaw8k:
    """Streaming 24kHz 16-bit PCM -> 8kHz mu-law converter."""

    def __init__(self) -> None:
        self._rate_state = None

    def convert(self, pcm: bytes) -> bytes:
        """Convert a chunk of 24kHz PCM bytes to 8kHz mu-law bytes."""
        if not pcm:
            return b""
        pcm_8k, self._rate_state = audioop.ratecv(
            pcm, PCM_WIDTH, 1, GEMINI_OUT_RATE, TWILIO_RATE, self._rate_state
        )
        # Encode each 16-bit PCM frame into a 1-byte mu-law sample.
        return audioop.lin2ulaw(pcm_8k, PCM_WIDTH)

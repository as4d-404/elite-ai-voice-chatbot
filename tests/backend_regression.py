"""Offline endpoint contracts. Providers are replaced; no database writes."""
import asyncio
import io
import json
import sys
import unittest
from tempfile import SpooledTemporaryFile
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import main
from fastapi import HTTPException, UploadFile

class Endpoints(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rows = {}
        self.calls = []
        self.outcome = 'booked'
        self.fail_write = False
        test = self
        class Table:
            def upsert(self, row, on_conflict):
                assert on_conflict == 'call_sid'
                self.row = row
                return self
            def execute(self):
                if test.fail_write: raise RuntimeError('simulated failure')
                test.rows[self.row['call_sid']] = self.row
        def completion(**kwargs):
            self.calls.append(json.loads(json.dumps(kwargs)))
            text = json.dumps({'outcome': self.outcome, 'notes': None}) if 'response_format' in kwargs else 'Glad to help. log_call_outcome(outcome="booked") end_call()'
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])
        audio = io.BytesIO()
        with wave.open(audio, 'wb') as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(24000); wav.writeframes(b'\0\0' * 2400)
        self.wav = audio.getvalue()
        fake = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=completion)), audio=SimpleNamespace(
            speech=SimpleNamespace(create=lambda **kw: SimpleNamespace(read=lambda: self.wav)),
            transcriptions=SimpleNamespace(create=lambda **kw: SimpleNamespace(text='What do you offer?'))))
        self.patches = [patch.object(main, 'groq_client', fake), patch.object(main, 'supabase', SimpleNamespace(table=lambda _: Table()))]
        for p in self.patches: p.start()
        main.conversation_store.clear()
    async def asyncTearDown(self):
        for p in self.patches: p.stop()
    async def test_http_route_contracts(self):
        import httpx
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            chat = await client.post('/api/chat', json={'session_id':'http-test','message':'Hey'})
            self.assertEqual(chat.status_code, 200)
            self.assertEqual(chat.json()['reply'], 'Glad to help.')
            audio = await client.post('/api/speak', json={'text':chat.json()['reply']})
            self.assertEqual(audio.status_code, 200)
            self.assertEqual(audio.headers['content-type'], 'audio/wav')
            self.assertEqual(audio.content[:4], b'RIFF')
            stt = await client.post('/api/transcribe', files={'file':('sample.wav',self.wav,'audio/wav')})
            self.assertEqual(stt.status_code, 200)
            self.assertEqual(stt.json()['text'], 'What do you offer?')
            final = await client.post('/api/chat/end', json={'session_id':'http-test'})
            self.assertEqual(final.status_code, 200)
            reset = await client.post('/api/chat/reset', json={'session_id':'http-test'})
            self.assertEqual(reset.json()['status'], 'cleared')

    async def test_three_turn_memory_and_clean_transcript(self):
        for text in ['Hey', 'What does Elite AI actually do?', 'I already answer my own phone.']:
            result = await main.chat(main.ChatRequest(session_id='test', message=text))
            self.assertEqual(result.reply, 'Glad to help.')
        self.assertEqual([len(c['messages']) for c in self.calls], [2,4,6])
        self.assertEqual(len(main.conversation_store['test']), 7)
        result = await main.end_session(main.EndSessionRequest(session_id='test'))
        self.assertIn('Maya: Glad to help.', result.transcript)
        self.assertNotIn('log_call_outcome', result.transcript)
        await main.end_session(main.EndSessionRequest(session_id='test'))
        self.assertEqual(len(self.rows), 1)
        self.assertIsNone(self.rows['test']['phone_number'])
        await main.chat_reset(main.ResetRequest(session_id='test'))
        self.assertNotIn('test', main.conversation_store)
    async def test_supported_outcomes_and_failure_retry(self):
        main.conversation_store['test'] = [{'role':'user','content':'test'}]
        for outcome in ['booked','callback','not_interested','do_not_call','voicemail','in_progress','invalid']:
            self.outcome = outcome
            result = await main.end_session(main.EndSessionRequest(session_id='test'))
            self.assertEqual(result.outcome, outcome if outcome != 'invalid' else 'in_progress')
        self.fail_write = True
        with self.assertRaises(HTTPException) as ctx:
            await main.end_session(main.EndSessionRequest(session_id='test'))
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn('test', main.conversation_store)
        self.fail_write = False
        await main.end_session(main.EndSessionRequest(session_id='test'))
    async def test_audio_contracts_and_empty_inputs(self):
        audio = await main.speak_text(main.SpeakRequest(text='Hello'))
        self.assertEqual(audio.media_type, 'audio/wav')
        self.assertEqual(audio.body[:4], b'RIFF')
        upload = SpooledTemporaryFile(); upload.write(self.wav); upload.seek(0)
        result = await main.transcribe_audio(UploadFile(filename='recording.wav', file=upload))
        upload.close()
        self.assertEqual(result['text'], 'What do you offer?')
        with self.assertRaises(HTTPException): await main.speak_text(main.SpeakRequest(text=' '))
        with self.assertRaises(HTTPException): await main.chat(main.ChatRequest(session_id='x', message=' '))
    async def test_extraction_failure_never_saves_false_outcome(self):
        main.conversation_store['test'] = [{'role':'user','content':'Book a demo.'}]
        def fail(**kwargs): raise RuntimeError('simulated extraction failure')
        with patch.object(main.groq_client.chat.completions, 'create', fail):
            with self.assertRaises(HTTPException) as ctx:
                await main.end_session(main.EndSessionRequest(session_id='test'))
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(self.rows, {})
        self.assertIn('test', main.conversation_store)

    def test_streaming_wav_header(self):
        import struct
        original = bytearray(self.wav)
        original[4:8] = b"\xff" * 4
        original[40:44] = b"\xff" * 4
        cleaned = main.finalize_wav_header(bytes(original))
        self.assertEqual(struct.unpack_from('<I', cleaned, 4)[0], len(cleaned)-8)
        with wave.open(io.BytesIO(cleaned)) as wav:
            self.assertEqual(wav.getnframes(), 2400)

    def test_sanitizer_preserves_prose(self):
        for text in ['Please call me tomorrow.', 'I can explain (briefly).', 'The log cabin is ready.']:
            self.assertEqual(main.clean_assistant_text(text), text)
        self.assertEqual(main.clean_assistant_text('Thanks! *Calling log...*'), 'Thanks!')

if __name__ == '__main__': unittest.main()

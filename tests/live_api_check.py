"""Opt-in live provider checks. Creates/deletes only uniquely named test rows."""
import asyncio, io, json, sys, uuid, wave
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import main

async def run():
    results = {}; ids = []
    try:
        sid = 'elite-regression-' + str(uuid.uuid4()); ids.append(sid)
        replies = []
        for text in ['Hey', 'What does Elite AI actually do?', 'I already answer my own phone.']:
            result = await main.chat(main.ChatRequest(session_id=sid, message=text)); replies.append(result.reply)
        results['chat_replies'] = replies
        results['memory_turns'] = len(main.conversation_store[sid])
        results['tool_leak'] = any(word in ' '.join(replies) for word in ['log_call_outcome','end_call','Calling log'])
        audio = await main.speak_text(main.SpeakRequest(text='Hey, this is Maya with Elite AI. What do you offer?'))
        Path('/tmp/elite-speech.wav').write_bytes(audio.body)
        with wave.open(io.BytesIO(audio.body)) as wav:
            results['wav'] = {'channels':wav.getnchannels(),'rate':wav.getframerate(),'sample_width':wav.getsampwidth(),'frames':wav.getnframes()}
        from fastapi import UploadFile
        results['stt'] = await main.transcribe_audio(UploadFile(filename='sample.wav', file=io.BytesIO(audio.body)))
        # Read aggregate-only historical evidence without printing stored customer content.
        historical = main.supabase.table('leads').select('id', count='exact').ilike('transcript', '%Jordan:%').limit(1).execute()
        results['historical_jordan_present'] = bool(historical.data)
        booking_id = 'elite-regression-' + str(uuid.uuid4()); ids.append(booking_id)
        booking_replies = []
        for text in ['Hey', 'Yes, it is a good time. My business is Regression Test. I miss calls after hours.', 'I want to book a demo on September 10, 2026 at 3 PM UTC. My phone is +12025550123.', 'Yes, I confirm that demo time. Thank you.']:
            reply = await main.chat(main.ChatRequest(session_id=booking_id, message=text))
            booking_replies.append(reply.reply)
        final = await main.end_session(main.EndSessionRequest(session_id=booking_id))
        results['booking_conversation'] = {'outcome': final.outcome, 'tool_leak': any(word in ' '.join(booking_replies) for word in ['log_call_outcome', 'end_call', 'Calling log']), 'replies': booking_replies}
        scenarios = {
            'booked': [('user', 'I want to book a demo on September 10, 2026 at 3 PM UTC. My business is Regression Test.'), ('assistant','September 10 at 3 PM UTC works for your demo. Thank you.'), ('user','Yes, confirmed. Thank you.')],
            'not_interested': [('user', "I'm not interested.")],
            'do_not_call': [('user', "Don't call me again. Remove me from your list.")],
            'in_progress': [('user','Hey'), ('assistant','Hey, this is Maya with Elite AI. Did I catch you at a bad time?')],
        }
        for expected, turns in scenarios.items():
            testid = 'elite-regression-' + str(uuid.uuid4()); ids.append(testid)
            main.conversation_store[testid] = [{'role': role, 'content': text} for role,text in turns]
            main.conversation_store[testid].insert(0, {'role': 'user', 'content': 'My number is +12025550123.'})
            try:
                result = await main.end_session(main.EndSessionRequest(session_id=testid))
                await main.end_session(main.EndSessionRequest(session_id=testid))
                rows = main.supabase.table('leads').select('id,outcome,transcript').eq('call_sid', testid).execute().data
                results[expected] = {'outcome':result.outcome, 'rows':len(rows), 'transcript_saved': bool(rows and rows[0]['transcript'])}
            except Exception as error:
                results[expected] = {'error_type': type(error).__name__, 'status':getattr(error,'status_code',None)}
    except Exception as error:
        results['blocked'] = {'error_type': type(error).__name__, 'status':getattr(error,'status_code',None)}
    finally:
        for sid in ids:
            try: main.supabase.table('leads').delete().eq('call_sid',sid).execute()
            except Exception: results['cleanup_failure'] = True
            main.conversation_store.pop(sid, None)
        Path('/tmp/elite-live-results.json').write_text(json.dumps(results, indent=2))
        print(json.dumps(results, indent=2))
asyncio.run(run())

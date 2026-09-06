"""Local Chrome CDP regression checks; API and microphone fixtures, real WAV playback.
Run after npm run build --prefix frontend and tests/live_api_check.py.
The script serves built artifacts on an ephemeral localhost port.
Screenshots/results are written only to /tmp/elite-verification.
"""
import re
import base64, json, subprocess, time, urllib.request, tempfile, threading, mimetypes
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from websockets.sync.client import connect

out = Path('/tmp/elite-verification'); out.mkdir(exist_ok=True)
audio = base64.b64encode(Path('/tmp/elite-speech.wav').read_bytes()).decode()
fixture = r'''
window.__test = { requests: [], plays: 0, pauses: 0, failSave: false, saved: false, delay: 100 };
const OriginalAudio = window.Audio;
window.Audio = function() {window.__test.audioElements=(window.__test.audioElements||0)+1;const audio=new OriginalAudio();window.__test.audio=audio;return audio;};
const originalPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function() { window.__test.plays++; return originalPlay.call(this); };
const originalPause = HTMLMediaElement.prototype.pause;
HTMLMediaElement.prototype.pause = function() { window.__test.pauses++; return originalPause.call(this); };
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, options = {}) => {
 const url = String(input); const t = window.__test;
 if (url.includes('/rest/v1/leads')) {
  t.requests.push({path:'leads'});
  const rows = t.saved ? [{id:'fixture-1',call_sid:'fixture-session',business_name:'Browser regression fixture',outcome:'booked',created_at:new Date().toISOString(),notes:'Fixture only',transcript:'Prospect: Hey\nMaya: Hello',followup_time:null}] : [];
  return new Response(JSON.stringify(rows),{status:200,headers:{'Content-Type':'application/json'}});
 }
 if (!url.includes('/api/')) return nativeFetch(input, options);
 const path = new URL(url, location.href).pathname;
 const body = options.body instanceof FormData ? {} : JSON.parse(options.body || '{}');
 t.requests.push({path,body});
 if (path === '/api/speak') {
  await new Promise(resolve => setTimeout(resolve,t.delay));
  return new Response(Uint8Array.from(atob('__AUDIO__'),c=>c.charCodeAt(0)),{headers:{'Content-Type':'audio/wav'}});
 }
 if (path === '/api/chat/end') {
  if(t.failSave) return new Response('{}',{status:503});
  t.saved=true;
  return new Response(JSON.stringify({outcome:'booked'}));
 }
 if(path === '/api/transcribe') return new Response(JSON.stringify({text:'What do you offer?'}));
 if(path === '/api/chat') return new Response(JSON.stringify({reply:'Hello from Maya. I can help with missed calls.'}));
 return new Response('{}');
};
navigator.mediaDevices.getUserMedia = async () => ({getTracks:()=>[{stop:()=>{window.__test.trackStopped=true;}}]});
window.MediaRecorder = class {
 static isTypeSupported() {return true;}
 constructor(stream, options) {this.mimeType=options?.mimeType || 'audio/webm';this.state='inactive';}
 start() {this.state='recording';}
 stop() {this.state='inactive';setTimeout(()=>{this.ondataavailable?.({data:new Blob(['fixture'],{type:this.mimeType})});this.onstop?.();},20);}
};
'''.replace('__AUDIO__',audio)
# Serve the built artifacts in the same process/network context as Chrome.
build = Path(__file__).resolve().parents[1] / 'frontend' / '.next'
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  path = self.path.split('?')[0]
  file = build / 'server/pages/index.html' if path == '/' else build / path.removeprefix('/_next/')
  if not file.is_file() or not file.resolve().is_relative_to(build.resolve()):
   self.send_error(404); return
  self.send_response(200); self.send_header('Content-Type', mimetypes.guess_type(str(file))[0] or 'application/octet-stream'); self.end_headers(); self.wfile.write(file.read_bytes())
 def log_message(self, *args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base_url = f'http://127.0.0.1:{server.server_port}'
profile=tempfile.mkdtemp(prefix='elite-browser-')
proc=subprocess.Popen(['/opt/google/chrome/chrome','--headless=new','--no-sandbox','--no-proxy-server','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0',f'--user-data-dir={profile}','about:blank'],stdout=subprocess.DEVNULL,stderr=open('/tmp/elite-chrome.log','w'))
results={}; seq=0
try:
 for _ in range(60):
  try:
   port=(Path(profile)/'DevToolsActivePort').read_text().splitlines()[0]
   tabs=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json',timeout=2));break
  except Exception: time.sleep(.3)
 ws=connect(next(tab for tab in tabs if tab['type'] == 'page')['webSocketDebuggerUrl']); print('Chrome connected',flush=True)
 def call(method,params=None):
  global seq
  seq+=1; ws.send(json.dumps({'id':seq,'method':method,'params':params or {}}))
  while True:
   data=json.loads(ws.recv(timeout=60))
   if data.get('id')==seq:
    if 'error' in data: raise RuntimeError(data['error'])
    return data.get('result',{})
 def js(expression):
  data=call('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True,'userGesture':True})
  if 'exceptionDetails' in data: raise RuntimeError(data['exceptionDetails'])
  return data.get('result',{}).get('value')
 def wait(expression,seconds=25):
  end=time.time()+seconds
  while time.time()<end:
   if js(expression): return
   time.sleep(.2)
  raise AssertionError('Timed out: '+expression)
 def click(label): js('document.querySelector('+json.dumps('button[aria-label='+json.dumps(label)+']')+').click()')
 def button(text): js(f'[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==={json.dumps(text)}).click()')
 def type_send(text):
  js(f'''(()=>{{const e=document.querySelector('input[aria-label="Type a message"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,{json.dumps(text)});e.dispatchEvent(new Event('input',{{bubbles:true}}));}})()''')
  time.sleep(.1);click('Send message')
 def shot(name,width,height):
  call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':False})
  time.sleep(.4)
  image=call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':True})
  (out/(name+'.png')).write_bytes(base64.b64decode(image['data']))
  overflow=js('document.documentElement.scrollWidth > innerWidth')
  assert not overflow, name+' horizontal overflow'
 call('Page.enable');call('Page.bringToFront');call('Browser.grantPermissions',{'origin':base_url,'permissions':['clipboardReadWrite','clipboardSanitizedWrite']});call('Page.addScriptToEvaluateOnNewDocument',{'source':fixture})
 call('Page.navigate', {'url':base_url})
 print('Loaded local production bundle',flush=True)
 wait('document.title.includes("Elite AI") && !!document.querySelector("[aria-label=Conversation]")',60)
 wait('window.__test.requests.some(r=>r.path==="leads")')
 for width,height in [(1440,900),(1920,1080),(375,812)]:shot(f'overview-{width}',width,height)
 results['overview_viewports']='PASS';print('Viewports captured',flush=True)
 button('voice');type_send('Hey')
 wait('window.__test.plays===1');wait('document.querySelector("[role=status]").textContent.includes("Speaking")')
 assert js('document.querySelector("[aria-label=Conversation]").children.length')==2
 results['typed_playback']='PASS'
 shot('voice-375',375,812)
 assert js('document.querySelector("input[aria-label] ")?.getBoundingClientRect().bottom < innerHeight')
 # Mic interruption twice; each speech transcript auto-sends once in the same session.
 for index in range(2):
  before=js('window.__test.requests.filter(r=>r.path==="/api/chat").length')
  click('Start recording');wait('document.querySelector("[role=status]").textContent.includes("Recording")')
  assert js('window.__test.audio.paused && window.__test.audioElements===1')
  click('Stop recording');wait(f'window.__test.requests.filter(r=>r.path==="/api/chat").length==={before+1}')
  wait(f'window.__test.plays==={index+2}')
 results['mic_barge_in_twice_autosend']='PASS (mock microphone, real audio element)'
 type_send('I already answer my own phone.');wait('window.__test.plays===4')
 assert js('new Set(window.__test.requests.filter(r=>r.path==="/api/chat").map(r=>r.body.session_id)).size')==1
 assert js('document.querySelector("[aria-label=Conversation]").children.length')==8
 results['mixed_context_typed_barge_in_no_duplicates']='PASS'
 # Invalidate a delayed old TTS response with another typed turn.
 js('window.__test.delay=1200');type_send('Delayed turn')
 wait('window.__test.requests.filter(r=>r.path==="/api/speak").length===5')
 type_send('Interrupt pending audio');wait('window.__test.requests.filter(r=>r.path==="/api/speak").length===6')
 time.sleep(1.5);assert js('window.__test.plays')==5
 results['stale_tts']='PASS'
 # Session survives navigation; failed save is retryable; success explicitly refetches.
 button('overview');wait('document.body.innerText.includes("Session time")');button('voice')
 js('window.__test.failSave=true');button('End Session');wait('document.body.innerText.includes("Retry Save")')
 js('window.__test.failSave=false');button('Retry Save');wait('document.body.innerText.includes("Session saved.")')
 assert js('window.__test.requests.filter(r=>r.path==="leads").length')>=2
 results['save_retry_explicit_refresh']='PASS'
 button('leads');wait('document.body.innerText.includes("Browser regression fixture")');button('DNC')
 assert js('document.body.innerText.includes("No leads yet")')
 button('All');shot('leads-375',375,812)
 button('history');js('document.querySelector("summary").click()');button('Copy transcript');wait('document.body.innerText.includes("Copied")');shot('history-375',375,812)
 click('Settings');shot('settings-375',375,812)
 results['leads_filters_history_settings_mobile']='PASS'
 button('voice');js('window.__test.delay=1200');type_send('End before playback');wait('window.__test.requests.filter(r=>r.path==="/api/speak").length===7')
 before=js('window.__test.plays');button('End Session');time.sleep(1.5);assert js('window.__test.plays')==before
 results['end_invalidates_playback']='PASS'
 button('Start Voice Session');click('Start recording');wait('document.querySelector("[role=status]").textContent.includes("Recording")')
 before=js('window.__test.requests.filter(r=>r.path==="/api/transcribe").length');button('End Session');time.sleep(.4)
 assert js('window.__test.requests.filter(r=>r.path==="/api/transcribe").length')==before
 results['end_discards_recording']='PASS'
except Exception as error:
 results['failure']=str(error)
 raise
finally:
 (out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2),flush=True)
 proc.terminate(); server.shutdown()

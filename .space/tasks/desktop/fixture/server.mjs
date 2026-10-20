import { createServer } from 'node:http';

const state = { clicks: 0, message: '' };
const page = `<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>MicroVM Desktop Check</title>
<style>
body{font:20px sans-serif;background:#eff4f8;color:#172b42;margin:64px;max-width:820px}
h1{font-size:36px}button,input{font:inherit;padding:12px;margin:10px 8px 10px 0}
button{background:#1565c0;color:white;border:0;border-radius:6px;cursor:pointer}
#result{padding:24px;background:white;border-radius:10px;white-space:pre-line}
</style>
<h1>MicroVM Desktop Check</h1>
<p>VM内のChromiumから localhost:3000 を表示しています。</p>
<button id="increment">Add one</button><span id="count">Clicks: 0</span>
<p><input id="message" placeholder="Type a message"><button id="save">Save message</button></p>
<div id="result">Ready</div>
<script>
async function refresh(){const s=await fetch('/state').then(r=>r.json());document.querySelector('#count').textContent='Clicks: '+s.clicks;document.querySelector('#result').textContent='Saved: '+s.message}
document.querySelector('#increment').onclick=async()=>{await fetch('/click',{method:'POST'});await refresh()};
document.querySelector('#save').onclick=async()=>{await fetch('/message',{method:'POST',body:document.querySelector('#message').value});await refresh()};
refresh();
</script></html>`;
createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/click') state.clicks++;
  if (request.method === 'POST' && request.url === '/message') {
    let text = '';
    for await (const chunk of request) text += chunk;
    state.message = text.slice(0, 200);
  }
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(state));
  }
}).listen(3000, '127.0.0.1');

/* Minimal local CDP driver shared by isolated browser contract tests. */
const {spawn}=require('node:child_process'), fs=require('node:fs'), path=require('node:path');
exports.launch=async function(output) {
  fs.mkdirSync(output,{recursive:true});
  const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+path.join(output,'chrome-profile'),'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let ws,session,nextId=0; const pending=new Map(),errors=[];
  try {
    const endpoint=await new Promise((resolve,reject)=>{let stderr='';const timer=setTimeout(()=>reject(new Error('Chrome start timeout: '+stderr.slice(-500))),20000);browser.stderr.on('data',data=>{stderr+=data;const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});browser.on('error',error=>{clearTimeout(timer);reject(error);});});
    ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    ws.onmessage=event=>{const data=JSON.parse(event.data);if(data.id&&pending.has(data.id)){const entry=pending.get(data.id);clearTimeout(entry.timer);pending.delete(data.id);data.error?entry.reject(new Error(JSON.stringify(data.error))):entry.resolve(data.result);}if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails);};
    function command(method,params={},sid=session){const id=++nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));});}
    const target=await command('Target.createTarget',{url:'about:blank'},null);session=(await command('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId;
    await command('Page.enable');await command('Runtime.enable');await command('Emulation.setTimezoneOverride',{timezoneId:'Asia/Kolkata'});
    const evaluate=async expression=>{const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const wait=async expression=>{const start=Date.now();while(Date.now()-start<10000){if(await evaluate(expression))return;await delay(50);}throw new Error('Condition not reached: '+expression);};
    return {command,evaluate,wait,delay,errors,
      click:selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
      fill:values=>evaluate(`for(const [id,value] of Object.entries(${JSON.stringify(values)})){const el=document.getElementById(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));}`),
      viewport:(width,height)=>command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<761}),
      screenshot:async name=>{const {data}=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(data,'base64'));},
      close:async()=>{try{await command('Browser.close',{},null);}catch{}ws.close();browser.kill();for(const entry of pending.values())clearTimeout(entry.timer);}
    };
  } catch(error){ws?.close();browser.kill();throw error;}
};

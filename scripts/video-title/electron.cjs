const {app,BrowserWindow}=require('electron');
const {readFile,writeFile}=require('node:fs/promises');
const path=require('node:path');
const root=process.argv[2];
app.setPath('userData',path.join(root,'profile')); app.setPath('sessionData',path.join(root,'session'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const wc=win.webContents;
  wc.session.webRequest.onBeforeRequest((_details,callback)=>callback({cancel:true}));
  wc.setWindowOpenHandler(()=>({action:'deny'})); wc.on('will-navigate',e=>e.preventDefault());
  wc.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  // Fixed empty built-in document only; never navigate to user content.
  await win.loadURL('about:blank');
  const data=JSON.parse(await readFile(path.join(root,'input.json'),'utf8'));
  const render=require('./render.cjs');
  const result=await wc.executeJavaScript(`(${render.toString()})(${JSON.stringify(data)})`);
  await writeFile(path.join(root,'image.png'),Buffer.from(result.png,'base64'),{flag:'wx',mode:0o600}); delete result.png;
  result.rendererVersion={electron:process.versions.electron,chrome:process.versions.chrome};
  await writeFile(path.join(root,'result.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
  app.exit(0);
}).catch(error=>{console.error(error.message);app.exit(1);});

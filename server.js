const express=require('express'),http=require('http'),crypto=require('crypto'),fs=require('fs'),{Server}=require('socket.io'),path=require('path');
const app=express(),server=http.createServer(app),io=new Server(server);const PORT=process.env.PORT||3000;app.use(express.static(path.join(__dirname,'..','public')));
const accounts=new Map(),sessions=new Map(),clubs=new Map();let clubCounter=1;
const DATA_FILE=path.join(__dirname,'data.json');
function saveData(){try{const data={clubCounter,accounts:[...accounts.values()],clubs:[...clubs.values()].map(c=>({...c,members:[...c.members]}))};fs.writeFileSync(DATA_FILE,JSON.stringify(data));}catch(e){console.error('saveData',e.message)}}
function loadData(){try{if(!fs.existsSync(DATA_FILE))return;const d=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));clubCounter=d.clubCounter||1;(d.accounts||[]).forEach(a=>accounts.set(a.handle.toLowerCase(),{...a,online:false}));(d.clubs||[]).forEach(c=>clubs.set(c.id,{...c,members:new Set(c.members||[])}));}catch(e){console.error('loadData',e.message)}}
loadData();
const BASE=[{id:'general',name:'общий',type:'text'},{id:'media',name:'медиа',type:'text'},{id:'lobby',name:'Лобби',type:'voice'},{id:'hangout',name:'Тусовка',type:'voice'}];
const RE=/^[A-Za-z0-9_]{3,20}$/;
function handle(v){const n=String(v||'').trim();return RE.test(n)?n:null}function display(v,f){const n=String(v||'').trim().replace(/[<>]/g,'').slice(0,32);return n||f}
function passHash(p,s){return crypto.scryptSync(String(p),s,64).toString('hex')}function makePass(p){const salt=crypto.randomBytes(16).toString('hex');return{salt,hash:passHash(p,salt)}}function checkPass(p,a){const h=passHash(p,a.salt);return crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(a.hash,'hex'))}
function pub(k){const a=accounts.get(k);return a?{handle:a.handle,displayName:a.displayName,avatar:a.avatar||'',status:a.online?'online':'offline',game:a.game||''}:null}
function me(s){const k=sessions.get(s.id);return k?accounts.get(k):null}function online(){return [...accounts.keys()].map(pub).filter(Boolean).filter(u=>u.status==='online')}function users(){io.emit('users',online())}
function code(){let c;do c=crypto.randomBytes(5).toString('base64url').slice(0,6).toUpperCase();while([...clubs.values()].some(x=>x.code===c));return c}
function newClub(name,owner){const id='club_'+clubCounter++;const c={id,name:display(name,'Новый клуб'),owner,code:code(),members:new Set([owner]),channels:BASE.map(x=>({...x})),messages:{general:[],media:[]}};clubs.set(id,c);return c}
function view(c,k){return{id:c.id,name:c.name,owner:c.owner,code:c.code,memberCount:c.members.size,channels:c.channels}}
function myClubs(k){return[...clubs.values()].filter(c=>c.members.has(k)).map(c=>view(c,k))}
function emitClubs(k){const sid=[...sessions].find(([,h])=>h===k)?.[0];if(sid)io.to(sid).emit('clubs',myClubs(k))}
function roomUsers(room){return[...(io.sockets.adapter.rooms.get(room)||[])].map(id=>pub(sessions.get(id))).filter(Boolean)}
function joinClubSocket(s,c){s.join(c.id);s.emit('club:join',view(c,sessions.get(s.id)));io.to(c.id).emit('club:participants',roomUsers(c.id))}

io.on('connection',s=>{
 s.on('auth:register',d=>{const h=handle(d?.handle),p=String(d?.password||'');if(!h)return s.emit('auth:error','User: только английские буквы, цифры и _. Например User123.');if(p.length<6)return s.emit('auth:error','Пароль должен быть не короче 6 символов.');const k=h.toLowerCase();if(accounts.has(k))return s.emit('auth:error','Такой User уже существует. Войди в него.');const hp=makePass(p);accounts.set(k,{handle:h,displayName:display(d?.displayName,h),avatar:d?.avatar||'',game:'',salt:hp.salt,hash:hp.hash,online:true});sessions.set(s.id,k);newClub('Wecsord Hub',k);saveData();s.emit('auth:ok',pub(k));users();emitClubs(k)});
 s.on('auth:login',d=>{const h=handle(d?.handle),p=String(d?.password||'');if(!h)return s.emit('auth:error','Введи User, например User123.');const k=h.toLowerCase(),a=accounts.get(k);if(!a||!checkPass(p,a))return s.emit('auth:error','Неверный User или пароль.');a.online=true;sessions.set(s.id,k);saveData();s.emit('auth:ok',pub(k));users();emitClubs(k)});
 s.on('profile:update',d=>{const a=me(s);if(!a)return;a.displayName=display(d?.displayName,a.handle);if(typeof d?.avatar==='string')a.avatar=d.avatar.slice(0,400000);a.game=String(d?.game||'').slice(0,60);s.emit('auth:ok',pub(a.handle.toLowerCase()));saveData();users()});
 s.on('club:create',d=>{const a=me(s);if(!a)return;const c=newClub(d?.name,a.handle.toLowerCase());saveData();s.emit('club:created',{invite:c.code});emitClubs(a.handle.toLowerCase());joinClubSocket(s,c)});
 s.on('club:joinByCode',v=>{const a=me(s),c=[...clubs.values()].find(x=>x.code===String(v||'').trim().toUpperCase());if(!a)return;if(!c)return s.emit('club:error','Код клуба не найден.');c.members.add(a.handle.toLowerCase());saveData();emitClubs(a.handle.toLowerCase());joinClubSocket(s,c)});
 s.on('club:select',id=>{const a=me(s),c=clubs.get(id);if(!a||!c||!c.members.has(a.handle.toLowerCase()))return;joinClubSocket(s,c)});
 s.on('club:createChannel',d=>{const a=me(s),c=clubs.get(d?.clubId);if(!a||!c||!c.members.has(a.handle.toLowerCase()))return;const n=String(d?.name||'канал').trim().toLowerCase().replace(/[^a-zа-яё0-9_-]/gi,'-').slice(0,28);if(!n)return;const ch={id:n+'_'+Date.now(),name:n,type:d?.type==='voice'?'voice':'text'};c.channels.push(ch);if(ch.type==='text')c.messages[ch.id]=[];saveData();io.to(c.id).emit('club:channels',c.channels)});
 s.on('messages:load',d=>{const a=me(s),c=clubs.get(d?.clubId);if(!a||!c||!c.members.has(a.handle.toLowerCase()))return;s.emit('messages:load',{channel:d.channel,messages:c.messages[d.channel]||[]})});
 s.on('message',d=>{const a=me(s),c=clubs.get(d?.clubId);if(!a||!c||!c.members.has(a.handle.toLowerCase()))return;const ch=String(d?.channel||''),t=String(d?.text||'').trim();if(!c.messages[ch]||!t)return;const m={name:a.displayName,handle:a.handle,avatar:a.avatar||'',text:t.slice(0,2000),time:new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})};c.messages[ch].push(m);saveData();io.to(c.id).emit('club:message',{channel:ch,message:m})});
 s.on('call:join',d=>{const a=me(s),c=clubs.get(d?.clubId);if(!a||!c||!c.members.has(a.handle.toLowerCase()))return;const room='call_'+c.id+'_'+String(d?.channel||'lobby');s.join(room);const ids=[...(io.sockets.adapter.rooms.get(room)||[])].filter(x=>x!==s.id);s.emit('call:peers',ids);s.to(room).emit('call:newPeer',s.id);s.to(room).emit('call:notice',{text:a.displayName+' подключился'});io.to(room).emit('call:participants',roomUsers(room))});
 s.on('call:offer',x=>io.to(x.to).emit('call:offer',{from:s.id,offer:x.offer}));s.on('call:answer',x=>io.to(x.to).emit('call:answer',{from:s.id,answer:x.answer}));s.on('call:ice',x=>io.to(x.to).emit('call:ice',{from:s.id,candidate:x.candidate}));s.on('call:leave',room=>{s.leave(room);s.to(room).emit('call:left',s.id);io.to(room).emit('call:participants',roomUsers(room))});
 s.on('disconnect',()=>{const k=sessions.get(s.id);if(k){sessions.delete(s.id);const a=accounts.get(k);if(a)a.online=false;users()}});
});
server.listen(PORT,()=>console.log('Wecsord 5.0 on '+PORT));

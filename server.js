
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;
const DATA = path.join(__dirname, "data.json");

app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"..","public")));

function load(){
  try { return JSON.parse(fs.readFileSync(DATA,"utf8")); }
  catch { return {users:[],spaces:[],messages:[],friendRequests:[]}; }
}
function save(db){ fs.writeFileSync(DATA,JSON.stringify(db,null,2)); }
function id(){ return crypto.randomBytes(8).toString("hex"); }
function safeUser(u){ if(!u) return null; const {passwordHash,...x}=u; return x; }
function usernameOK(u){ return /^[A-Za-z0-9_]{3,20}$/.test(u); }

app.get("/api/health",(req,res)=>res.json({ok:true,version:"7.0.0"}));

app.post("/api/register",async(req,res)=>{
  const {username,password,displayName}=req.body||{};
  if(!usernameOK(username||"")) return res.status(400).json({error:"Username: 3-20 английских букв, цифр или _"});
  if(typeof password!=="string" || password.length<6) return res.status(400).json({error:"Пароль должен быть не короче 6 символов"});
  const db=load();
  if(db.users.some(x=>x.username.toLowerCase()===username.toLowerCase())) return res.status(409).json({error:"Такой User уже существует"});
  const user={id:id(),username,displayName:(displayName||username).slice(0,32),avatar:"",status:"online",game:"",friends:[],createdAt:Date.now(),passwordHash:await bcrypt.hash(password,10)};
  db.users.push(user); save(db);
  res.json({user:safeUser(user)});
});

app.post("/api/login",async(req,res)=>{
  const {username,password}=req.body||{}; const db=load();
  const user=db.users.find(x=>x.username.toLowerCase()===(username||"").toLowerCase());
  if(!user || !(await bcrypt.compare(password||"",user.passwordHash))) return res.status(401).json({error:"Неверный User или пароль"});
  user.status="online"; save(db); res.json({user:safeUser(user)});
});

app.get("/api/me/:id",(req,res)=>{
  const u=load().users.find(x=>x.id===req.params.id); if(!u) return res.status(404).json({error:"Не найден"});
  res.json({user:safeUser(u)});
});

app.patch("/api/users/:id", (req,res)=>{
  const db=load(), u=db.users.find(x=>x.id===req.params.id);
  if(!u) return res.status(404).json({error:"Не найден"});
  const {displayName,avatar,game}=req.body||{};
  if(displayName!==undefined) u.displayName=String(displayName).slice(0,32);
  if(avatar!==undefined) u.avatar=String(avatar).slice(0,400000);
  if(game!==undefined) u.game=String(game).slice(0,40);
  save(db); io.emit("user:update",safeUser(u)); res.json({user:safeUser(u)});
});

app.get("/api/users/:id/friends",(req,res)=>{
  const db=load(), u=db.users.find(x=>x.id===req.params.id); if(!u) return res.status(404).json({error:"Не найден"});
  res.json({friends:u.friends.map(fid=>safeUser(db.users.find(x=>x.id===fid))).filter(Boolean)});
});

app.post("/api/friends/request",(req,res)=>{
  const db=load(), {from,to}=req.body||{}, a=db.users.find(x=>x.id===from), b=db.users.find(x=>x.id===to);
  if(!a||!b) return res.status(404).json({error:"Пользователь не найден"});
  if(a.id===b.id) return res.status(400).json({error:"Нельзя добавить себя"});
  if(a.friends.includes(b.id)) return res.status(400).json({error:"Вы уже друзья"});
  if(!db.friendRequests.some(r=>r.from===a.id&&r.to===b.id&&r.status==="pending")){
    db.friendRequests.push({id:id(),from:a.id,to:b.id,status:"pending",createdAt:Date.now()}); save(db);
  }
  io.to("user:"+b.id).emit("friend:request",safeUser(a)); res.json({ok:true});
});

app.get("/api/friends/requests/:id",(req,res)=>{
  const db=load();
  const list=db.friendRequests.filter(r=>r.to===req.params.id&&r.status==="pending").map(r=>({...r,fromUser:safeUser(db.users.find(u=>u.id===r.from))}));
  res.json({requests:list});
});

app.post("/api/friends/respond",(req,res)=>{
  const db=load(), r=db.friendRequests.find(x=>x.id===req.body.id);
  if(!r) return res.status(404).json({error:"Заявка не найдена"});
  if(req.body.accept){
    const a=db.users.find(x=>x.id===r.from), b=db.users.find(x=>x.id===r.to);
    if(a&&!a.friends.includes(b.id)) a.friends.push(b.id);
    if(b&&!b.friends.includes(a.id)) b.friends.push(a.id);
    r.status="accepted"; save(db);
    io.to("user:"+a.id).emit("friend:accepted",safeUser(b));
    io.to("user:"+b.id).emit("friend:accepted",safeUser(a));
  } else { r.status="rejected"; save(db); }
  res.json({ok:true});
});

app.get("/api/search/users",(req,res)=>{
  const q=String(req.query.q||"").toLowerCase();
  const db=load();
  res.json({users:db.users.filter(u=>u.username.toLowerCase().includes(q)||u.displayName.toLowerCase().includes(q)).slice(0,20).map(safeUser)});
});

app.get("/api/spaces/:userId",(req,res)=>{
  const db=load();
  res.json({spaces:db.spaces.filter(s=>s.members.includes(req.params.userId))});
});

app.post("/api/spaces",(req,res)=>{
  const db=load(), {ownerId,name}=req.body||{};
  if(!db.users.some(u=>u.id===ownerId)) return res.status(404).json({error:"Владелец не найден"});
  const space={id:id(),name:String(name||"Новый Space").slice(0,40),ownerId,members:[ownerId],invite:crypto.randomBytes(5).toString("hex").toUpperCase(),channels:[
    {id:id(),name:"lounge",type:"text"},{id:id(),name:"hangout",type:"voice"}
  ]};
  db.spaces.push(space); save(db); res.json({space});
});
app.post("/api/spaces/join",(req,res)=>{
  const db=load(), {userId,invite}=req.body||{}, s=db.spaces.find(x=>x.invite.toUpperCase()===String(invite||"").toUpperCase());
  if(!s) return res.status(404).json({error:"Приглашение не найдено"});
  if(!s.members.includes(userId)) s.members.push(userId);
  save(db); io.to("user:"+userId).emit("space:joined",s); res.json({space:s});
});
app.post("/api/spaces/:id/channels",(req,res)=>{
  const db=load(), s=db.spaces.find(x=>x.id===req.params.id);
  if(!s||s.ownerId!==req.body.ownerId) return res.status(403).json({error:"Только владелец может создавать комнаты"});
  const c={id:id(),name:String(req.body.name||"room").replace(/[^A-Za-z0-9_-]/g,"").slice(0,24)||"room",type:req.body.type==="voice"?"voice":"text"};
  s.channels.push(c); save(db); res.json({channel:c});
});

app.get("/api/messages/:channelId",(req,res)=>{
  const db=load(); res.json({messages:db.messages.filter(m=>m.channelId===req.params.channelId).slice(-100)});
});

io.on("connection",socket=>{
  socket.on("user:online",userId=>{ socket.join("user:"+userId); socket.data.userId=userId; });
  socket.on("chat:join",channelId=>socket.join("chat:"+channelId));
  socket.on("chat:send",m=>{
    if(!m||!m.channelId||!m.userId||!String(m.text||"").trim()) return;
    const msg={id:id(),channelId:m.channelId,userId:m.userId,text:String(m.text).slice(0,2000),at:Date.now()};
    const db=load(); db.messages.push(msg); if(db.messages.length>5000) db.messages=db.messages.slice(-5000); save(db);
    io.to("chat:"+m.channelId).emit("chat:message",msg);
  });
  socket.on("voice:join",({channelId,user})=>{
    socket.join("voice:"+channelId); socket.data.voice=channelId;
    socket.to("voice:"+channelId).emit("voice:user-joined",{socketId:socket.id,user});
  });
  socket.on("voice:leave",channelId=>{
    socket.leave("voice:"+channelId); socket.to("voice:"+channelId).emit("voice:user-left",{socketId:socket.id});
  });
  socket.on("webrtc:offer",d=>io.to(d.to).emit("webrtc:offer",{from:socket.id,offer:d.offer}));
  socket.on("webrtc:answer",d=>io.to(d.to).emit("webrtc:answer",{from:socket.id,answer:d.answer}));
  socket.on("webrtc:ice",d=>io.to(d.to).emit("webrtc:ice",{from:socket.id,candidate:d.candidate}));
  socket.on("disconnect",()=>{ if(socket.data.voice) socket.to("voice:"+socket.data.voice).emit("voice:user-left",{socketId:socket.id}); });
});

server.listen(PORT,"0.0.0.0",()=>console.log("Wecsord 7.0 running on port "+PORT));
